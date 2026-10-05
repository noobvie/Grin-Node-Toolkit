# Script 07 — Public Mining Pool (Design)

> **Covers code as of:** 2026-10-04 for §19.15 *R2 review* and the §19.14 R2 row (the C5–C7 working tree as R2 read it — games `play/server/**`, `play/shell/**`, pool `public_html/**`, `back-end-pool/**`, `07_lib_pool_games.sh` — plus R2's fix in games `lib/guests.js` + `lib/ratelimit.js`; uncommitted, not VPS-tested) · 2026-10-04 for §19.15 *Part C7*, the §19.14 C7 row and the §19.17.7 as-built pointer (the C7 working tree: games `play/shell/**` — NEW `play-chat-core.js`, `chat-bubble.js`, `chat-bubble.css` — and `lib/app.js` `rules.mode`; pool `public_html/js/branding.js`, NEW `public_html/js/cms-frame.js`, `page.html`, `post.html`; uncommitted, not VPS-tested) · 2026-10-04 for §19.15 *Part C6*, the §19.14 C6 row and the §19.17.3 PoW note (the C6 working tree: `play/shell/**` — NEW `play-guest.js`, `play-pow.js`; three sentences in games `lib/http.js`; one label in the pool admin `games.html`; uncommitted, not VPS-tested) · 2026-10-04 for §19.15 *Part C5*, the §19.14 C5 row and the §19.4 v5 SQL (the C5 working tree: games `lib/guests.js`, `lib/tickets.js`, schema v5 and the hooks named in §19.15 *Part C5*; uncommitted, not VPS-tested) · 2026-10-04 for §19.15 *R1 review*, the §19.14 R1 row and the §19.17.5 pool-name pointer (the C1–C4 working tree as R1 read it, plus R1's two fixes to `name-rule.js` (both copies) and the shared fixture; uncommitted, not VPS-tested) · 2026-10-04 for §19.15 *Part C4*, the §19.14 C4 row, the §19.17.6 pointer, the §18 C4 note and the §18.11 C4 pointer (donor names auto-checked — the files named in *Part C4*; uncommitted, not VPS-tested) · 2026-10-04 for §19.15 *Part C3*, the §19.14 C3 row, the §19.4 v4 block and the two §19.17.5 pointers (names v2 — the files named in *Part C3*; uncommitted, not VPS-tested) · 2026-10-04 for §19.15 *Part C2*, the §19.14 C2 row and the two §19.3 default cells + health shape (launch state, Community header group, defaults on — the files named in *Part C2*; uncommitted, not VPS-tested) · 2026-10-04 for §19.15 *Part C1* and the §19.14 C1 row (Option B as built: `public_html/js/branding.js`, `public_html/js/ads.js`, a `public-shell.js` comment, `back-end-pool/lib/ads.js`, `lib/pool-settings.js`, the `index.js` step-up list, `admin-panel/ads.html`, `admin-panel/settings-analytics.html` — uncommitted, not VPS-tested; §19.17's text is unchanged by it) · 2026-10-03 for §19.17 and the edits it made elsewhere in §19 (v2 open community, Part C0 — a DESIGN written BEFORE any code, against the uncommitted games working tree as Part 12 left it and the pool files named in the plan's C1–C7 prompts; the code facts it leans on were read, not run: `branding.js` `applyAnalytics`/`cloneScript`/`CREDENTIAL_PAGES`, `ads.js`'s `code` type, `public-shell.js` NAV, `donor-names.js` `RESERVED` + the substring-matched `STARTER_BLOCKLIST`, `pool-settings.js` games defaults, `play/server/lib/settings.js`. Nothing in §19.17 exists in code yet) · 2026-10-03 for §20.1–§20.6 (Node availability — the DESIGN, written before any code, against `back-end-pool/lib/grin-node.js`, `lib/block-monitor.js`, `lib/alert-monitor.js`, `index.js` `buildPoolStatus` and the `grin-pool-manager` unit template as committed at `65d5061`. Parts 6–8 and the R2 fixes are built, uncommitted and never run; where they differ, the as-built record wins: the §20.5–§20.8 as-built notes moved to `script07_implementation.md` §10.15 on 2026-10-03) · 2026-10-03 for three line notes about the admin Payouts split (the §6 not-built list's `users.html` nav title **Security**, §8.1.4's status-list bullet, and the abandoned-balances CODE MAP note; written against the uncommitted payouts-split working tree, detail in impl §10.14) · 2026-09-28 for §19.16, §19.15 *Part 12*, the §19.4 v3 block, D19's amendment, the §19.10 name line, the §19.11 `games-names.html` row, §19.13 #21 and the §19.14 Part 12 row (approved nicknames: `play/server/lib/names.js` + its wiring, `play/shell/js/play-names.js`, `admin-panel/games-names.html`, written against the uncommitted working tree) · 2026-09-28 for §19.15 *Part 11 review*, the §19.14 Part 11 row, the §19.6 settings paragraph and the §19.8 free-match sentence (the whole games platform as reviewed — `play/**`, `back-end-pool/lib/games-link.js`, `scripts/lib/07_lib_pool_games.sh` + hooks — plus the review's own fixes, written against the uncommitted working tree) · 2026-09-28 for the §19.6 / §19.8 / §19.11 Part 10 edits, the §19.14 Part 10 row and §19.15 *Part 10* (PvP in `play/server/lib/{matches,ratings}.js`, `play/shell/js/play-lobby.js` + the board in `play-shell.js`, `admin-panel/games{,-players}.html`, written against the uncommitted working tree) · 2026-09-28 for D21, the §19.4 v2 tables, the §19.10 report / change-feed / moderator paragraphs, the §19.11 edits, the §19.14 Part 8–9 rows and §19.15 *Part 8* + *Part 9* (the chat + moderation code in `play/server/lib/`, the G-07 panel in `play/shell/`, `admin-panel/games{,-chat,-players}.html` + `games-admin.js`, written against the uncommitted working tree) · 2026-09-28 for the §19.14 Part 7 row, §19.15 *Part 7*, §19.9's `reward_json` line, §19.11's `games-events.html` row and the §19 heading (leaderboards, events and the admin guard in `play/server/lib/`, the G-06 panel in `play/shell/`, `admin-panel/games-events.html` + the Games NAV group, written against the uncommitted working tree) · 2026-09-27 for the §19.14 Part 6 row, §19.15 *Part 6* and §19 heading (the shell + chess frame in `play/shell/` + `play/games/chess/frame/`, `public_html/js/public-shell.js` and `_pgs_stage_trees`, written against the uncommitted working tree) · 2026-09-27 for the §19.14 Part 5 row, §19.6's points note and §19.15 *Part 5* (registry, matches and chess in `play/server/lib/` + `play/games/chess/`, written against the uncommitted working tree) · 2026-09-27 for the §19.14 Part 4 + checkpoint A rows and §19.15 *Part 4* (login, sessions, activity sync and ledger in `play/server/lib/`, written against the uncommitted working tree) · 2026-09-27 for §19.12's *As built* note, the §19.14 Part 3 row and §19.15 *Part 3* (the operator side, `scripts/lib/07_lib_pool_games.sh` + its hooks in the pool, backup and migrate scripts, written against the uncommitted working tree) · 2026-09-27 for §19's heading, the §19.3 common-rules bullet + settings note, the §19.11 fast-write table, the §19.14 Part 2 row and §19.15 *Part 2* (the pool link, `back-end-pool/lib/games-link.js` + its mount lines, written against the uncommitted working tree) · 2026-09-27 for the §19.14 Part 1 row and §19.15 *Part 1* (the games service skeleton in `play/server/`, written against the uncommitted working tree) · design only, 2026-09-27, for the rest of §19 (games platform — Parts 5–13 have no code yet; the pool facts it cites were read in the working tree that day: `GRIN_ADDR_RE`, `secureAdmin`/`freshAdmin`, `maskAddr`, `verifyOwnerProof`'s return contract, `hashrate_history` + `idx_hashrate_time`, `HashrateTracker.recordHashrates`, `RESERVED_ADDRESSES`) · 2026-09-27 for §8's "Why this is safe", "One send at a time", "Held resolves itself" and "The operator" bullets (the uncommitted /review-fix working tree), and for §15.5's "Response binding" bullet (the uncommitted binding-fix working tree) · 2026-09-26 for §6's four admin withdrawal / Tor-pause rows and §8's opening line, Tor row, no-auto-payout paragraph, balance-model table, the NEW "One Tor attempt, then an answer" section (which replaced "What moves a Tor payout on"), the pre-flight paragraph's two additions, and the §8.1 heading + status note (the uncommitted one-attempt Tor payout working tree) · 2026-09-25 for §6's `/withdraw/:id/slatepack` row (written with the code) · 2026-09-25 for §8's Tor-row note, the no-auto-payout paragraph, the two new paragraphs after the balance model, and the §8.1 heading + status note + §8.1.1 annotation (the uncommitted Tor-payout-hardening working tree, F1–F5 built); the body of §8.1 is the DESIGN as written that day against the Tor rail after F1–F4, before F5 was built — as-built deltas live in impl §10.8 · 2026-09-24 for §18.10 Parts 1–6 + §18.11 (per-share donation, the donor-profile backend, the admin review queue, the public wall and the account page, written against the uncommitted working tree) · 2026-09-23 for §4's effective-latency note, §11's gateway :443 note and §13.13 (hub move + connect-page latency, written against the uncommitted working tree) · 2026-09-07 for the multi-region surface (§2–§7, §11–§12, rewritten against the live code) · 2026-06-08 for the rest of the §6 endpoint table
> **Last verified:** **2026-10-04, PARTIAL — by the R2 review session (which built none of C5–C7)**: §19.17.3/.4/.7, threat notes #22 and #26–#30 and the §19.15 *Part C5*–*C7* departures named in §19.15 *R2 review* were read against the working tree and probed (a harness against the real games app, headless Edge); the rest of §19 was not re-checked · **2026-10-04, PARTIAL — §19.15 *Part C7* only, by the C7 builder against its own code (tests + a headless-Edge probe; not an independent check)** · **2026-10-04, PARTIAL — §19.15 *Part C6* only, by the C6 builder against its own code (tests + a headless-Edge probe; not an independent check)** · **2026-10-04, PARTIAL — by the R1 review session (which built none of C1–C4)**: §19.17.1/.2/.5/.6/.8 and threat notes #22–#25 read against the working tree; of the §19.15 *Part C1–C4* notes, the claims named in §19.15 *R1 review* were checked in code (C1 items 1–8 except the per-file innerHTML counts, C2 items 1, 2, 5–8, 11, 13, C3 items 1–3, 5, 6, 8–10, C4 items 1, 2, 4–6, 8, 9, 15) and the rest — the test counts, the CSP inventory, the v4 data step, the admin-page UI — were NOT re-verified; the nav matrix rendered in headless Edge; both suites re-run (pool 2795, games 1114) · §19.15 *Part C4*: never verified (written with the code it describes; R1 checks it) · §19.15 *Part C3*: never verified (written with the code it describes; R1 checks it — the §19.4 v4 block alone is machine-checked: `test-skeleton.js` executes it against the migration) · §19.15 *Part C2*: never verified (written with the code it describes; R1 checks it) · §19.15 *Part C1*: never verified (written with the code it describes; R1 checks it — a passing suite verifies the code, not this text) · §19.17: never verified (a design for code that does not exist yet; R1 and R2 check the builds against it) · §20: never systematically verified (the design was written before the code; its as-built notes, now in implementation §10.15, were written with the code, and a passing test suite verifies the code, not this text) · 2026-10-03, PARTIAL — **the three Payouts-split line notes only, by the docs-fold session**: the `users.html` NAV title, `STATUS` in `payments.html`, `PAYOUT_ACTIVE_STATUSES` in `payouts-common.js` and the dormancy/manual-payout placement were read in the working tree. · 2026-09-28, PARTIAL — **§19.16, §19.15 *Part 12*, the §19.4 v3 block and the Part 12 line edits only, by the Part 12 build session**: each statement read against `play/server/lib/{names,auth,chat,leaderboard,events,matches,moderation,app,db,settings}.js`, `play/shell/js/play-names.js` and `admin-panel/games-names.html` as written that session; §19.4 is test-bound (`test-skeleton.js`); games `npm test` 1010/1010, pool 2341/2341; no browser probe, nothing run on a VPS. · 2026-09-28, PARTIAL — **§19.13's threat notes and §19.15 *Part 11 review* only, by the Part 11 review session** (a session that built none of Parts 1–10): each answer read against the code it cites; games `npm test` 921/921, pool 2330/2330; nothing run on a VPS. The rest of §19 was NOT re-verified line by line. · 2026-09-28, PARTIAL — **§19.14's Part 10 row, §19.15 *Part 10* and the §19.6 / §19.8 / §19.11 edits only, by the Part 10 build session**: each delta read against `play/server/lib/{matches,ratings,settings}.js`, `play/shell/js/{play-lobby,play-shell,play-boards}.js` and `games-players.html` as written that session; games `npm test` 918/918 (NEW `test-pvp.js` 90), pool `npm test` 2322/2322, a headless-Edge probe of the PvP board + lobby (dark only). · Earlier: 2026-09-28, PARTIAL — **D21, §19.4's v2 block, the §19.10 / §19.11 edits, §19.14's Part 8–9 rows and §19.15 *Part 8* + *Part 9* only, by the Part 8–9 build session**: each delta read against `play/server/lib/{chat,moderation,auth,settings,db,app}.js`, `play/shell/js/play-chat.js` and the three admin pages as written that session; §19.4's block is test-bound (games `npm test` 815/815, NEW `test-chat.js` 171), pool `npm test` 2322/2322, a headless-Edge probe 58/58. · Earlier: 2026-09-28, PARTIAL — **§19.14's Part 7 row, §19.15 *Part 7* and the §19.9 / §19.11 line edits only, by the Part 7 build session**: each delta read against `play/server/lib/{leaderboard,events,admin,badges}.js`, `lib/events/*`, `play/shell/js/play-boards.js` and `games-events.html` as written that session; games `npm test` 630/630 (NEW `test-events.js` 101), pool `npm test` 2301/2301 (`test-admin-panel.js` [13]), a one-shot headless-Edge probe 58/58 of the /play/ panel under the real shell CSP; `games-events.html` not opened in a browser; nothing run on a VPS. Before that: 2026-09-27, PARTIAL — **§19.14's Part 6 row and §19.15 *Part 6* only, by the Part 6 build session**: each delta read against `play/shell/**`, `play/games/chess/frame/**`, `public-shell.js` and `_pgs_stage_trees` as written that session; games `npm test` 519/519 (NEW `test-shell.js` 68, five mutations each turning it red), pool `npm test` 2290/2290, a one-shot headless-Edge probe 48/48 against the staged tree with the real nginx headers; nothing run on a VPS. The same session also REPAIRED this file: the Part 5 session's write of §19.15 *Part 5* #1 had expanded a literal `$` + backtick as a perl pre-match, pasting a second copy of lines 1–4377 mid-sentence (9 314 lines); the duplicate was checked byte-identical to the file's own prefix before it was cut, so nothing unique was lost. Before that: 2026-09-27, PARTIAL — **§19.14's Part 5 row and §19.15 *Part 5* only, by the Part 5 build session**: each delta read against `play/server/lib/{registry,matches,settings,app,http}.js` and `play/games/chess/` as written that session; games `npm test` 451/451 on Windows (NEW `test-matches.js` 133, with perft exact on five reference positions); nothing run on a VPS. Before that: 2026-09-27, PARTIAL — **§19.14's Part 4 row and §19.15 *Part 4* only, by the Part 4 build session**: each delta read against `play/server/lib/{pool-link,ratelimit,ledger,plays,sessions,auth,mode,settings}.js` and `app.js` as written that session; games `npm test` 318/318 on Windows, with four mutations each turning `test-auth.js` red; nothing run on a VPS. Before that: 2026-09-27, PARTIAL — **§19.12's *As built* note, §19.14's Part 3 row and §19.15 *Part 3* only, by the Part 3 build session**: each delta was read in `07_lib_pool_games.sh` and the hooks as written that session; `bash -n` on the pool script and the three touched libs; the nginx snippet heredoc rendered with the mainnet constants and read; the deploy staging run once against the checkout. Nothing ran on a VPS. Same day, PARTIAL — **§19.3's common-rules bullet and settings note, §19.11's fast-write table, §19.14's Part 2 row and §19.15 *Part 2* only, by the Part 2 build session**: each statement was checked against `lib/games-link.js`, `lib/pool-settings.js`, `lib/config.js` and the `index.js` mount lines as written that session; the activity plan was run with `EXPLAIN QUERY PLAN` on the real schema, with and without the `INDEXED BY` pin; pool `npm test` exit 0, 2282 passed / 0 failed. Nothing was run against a live pool or on a VPS. Same day, PARTIAL — **§19.14's Part 1 row and §19.15 *Part 1* only, by the Part 1 build session**: each delta was read in the code it describes; the games `npm test` passed 155/155 on Windows (the 0600 mode and SIGTERM checks are POSIX-only and were skipped); §19.4's SQL block was compared with the v1 migration mechanically by that suite (35 objects), and that comparison was mutation-checked to fail on a changed default, CHECK or partial index. Nothing was run on a VPS. Same day, PARTIAL — **§15.5's "Response binding" bullet only, by the session that made the binding fix**: both finalize paths read in `lib/withdrawal-scheduler.js` after the edit; `npm test` exit 0 (impl §10.10 *Slatepack finalize binding*). Same day, PARTIAL — **the four §8 bullets listed under *Covers code as of* for that date only, by the session that made the /review fixes**: each rule read in `lib/withdrawal-scheduler.js` and `lib/wallet-tor.js` after the edit; the grin-wallet v5.5.0 behaviour behind them (the CLI's coin selection and late lock, `tx_slate_state` never updated on the sender, `cancel_tx` needing a node) read in the upstream source that session; `npm test` exit 0 (impl §10.10 *Review fixes*). 2026-09-26, PARTIAL — **the 2026-09-26 §6 / §8 / §8.1 edits listed under *Covers code as of* only, by the one-attempt docs-fold session**: the outcomes, the Held two-read rule and 24 h alert, the forced-refund refusals, the post-failure probe codes, the pause constants and its place before the probe, the Tor-only cooldown exemption, the `walletBin` fix and the deleted stepwise settings were read in the working tree (`lib/withdrawal-scheduler.js`, `index.js`, `lib/wallet-tor.js`); the offer's hide rules were grepped in `account-settings.html`, not re-run; `npm test` exit 0 (21 suites, 1900). The lock-before-broadcast fact comes from the Session 4 review's v5.5.0 source read and was **not re-checked**. The four rejection reasons are the operator's, recorded as given. 2026-09-25, PARTIAL — **§8's four edits listed under *Covers code as of* only, by the Tor-payout-hardening docs-fold session**: `SHORTFALL_RETRY_S`/`TOR_DOWN_RETRY_S` and both caps, `UNMINED_ALERT_S`, the repost limits, the `confirmed`-only kernel backfill, the `payout_unmined` levels and the settings removal read in the working tree; the "kernel written at lock, rewritten at finalize" fact is the F1 build session's source read, not re-checked. Same day, PARTIAL — **§8.1 only, by the F5 design session**: every grin-wallet claim was read in the v5.5.0 and v5.4.1 source (both tags cloned; file + function cited in place), and every pool claim was read in the working tree. §8.1.1's "exits 0 on a failed Tor delivery" comes from the source, not from running the binary; no test ran and nothing was built. The rest of §8 was not re-checked, and its "Auto-payout" paragraph is known stale (F4 deleted the keys; Part 7 of that plan folds it). 2026-09-24, PARTIAL — **§18.9 → §18.11 *Part 6* only, by the §18 Part 6 review session (cold, separate from the builders)**: each §18.9 point answered against the code diff, not the build notes — the greps, a stub-DB distribution + `computeReconciliation` run, a 60,043-input banner-parser fuzz and the public-route inventory are that session's own; `npm test` 1343/1343 before the fix and 1345/1345 after. The 390 px probe claims of Parts 4–5 were **not** re-run. Same day, PARTIAL — **§18.10 Part 5 row + §18.11 *Part 5* only, by the §18 Part 5 build session**: each delta read in the code it describes; `npm test` 1343/1343; the panel's states and layout measured with a one-shot 390 px headless-Edge probe (four fixtures, both themes). Same day, PARTIAL — **§18.10 Part 4 row + §18.11 *Part 4* only, by the §18 Part 4 build session**: each delta read in the code it describes; `npm test` 1331/1331; the page's layout claims measured with a one-shot 390/1280 px headless-Edge probe in both themes. Same day, PARTIAL — **§18.10 Part 3 row + §18.11 *Part 3* only, by the §18 Part 3 build session**: each delta read in the code it describes; `npm test` 1310/1310; the cookie attributes behind delta 1 read in `index.js`; the admin CSP line checked to be byte-identical to before the build. Same day, PARTIAL — **§18.10 Part 2 row + §18.11 *Part 2* only, by the §18 Part 2 build session**: each delta read in the code it describes; `npm test` 1298/1298; the multer boundary measured with a one-shot fake-stream run; §18.4's "no deploy-script change" claim grepped in the pool script. Same day, PARTIAL — **§18.10 Part 1 row + §18.11 *Part 1* only, by the §18 Part 1 build session**: each delta read in the code it describes; `npm test` 1145/1145. The rest of §18 is design, not a claim about code. 2026-09-23, PARTIAL — **§13.13's dark-gate / restored-pool bullets and §13.13.6 only, by the Part 9 review session**, read against the code it changed. Also 2026-09-23, PARTIAL — **§13.13 (hub move + latency), by the fold session only**: the names, keys and menu keys it cites grepped in the code (`B → 6/7` dispatch in `07_lib_pool_backup.sh`, the `pmg_*` function list, `probe_host`/`probe_enabled`/`grin-gateway-probe`/`maxconn 2000` in `07_lib_gateway.sh`, `latency_probe_domain`/`latency_hub_url`/the page `connect-src` in the pool script, `SEED_VERSION = 3` and the `_state`/`local_region` stamp in `lib/db.js`, `payout_control.before` in the manifest), the suggest route read in full in `index.js` (privacy + cache claims) and the header + `pickRecommended` of `lib/connect-suggest.js`; `npm test` re-run that session, 1133/1133 across 19 suites. **Taken from the seven build sessions' own reports, not re-checked:** the step order inside Migrate OUT/IN, the harness counts, the nginx/haproxy runtime measurements (incl. the 40-request `limit_req` figure), the Globalping numbers and the downtime estimate. Also 2026-09-23, PARTIAL — **§8's new Tor pre-flight paragraph only**, read against `lib/wallet-tor.js` (`REASONS`, `classifyProbeError`, `probeToronlineStatus`) and the `index.js` withdraw-route gate (null → allow + warn, false → 409, runs before `createWithdrawal`). The rest of §8 was not re-checked. Also 2026-09-23, PARTIAL — **§17 (all of it), by the Part 4 review**: every §17.2 decision and §17.4 threat note read against `lib/owner-proof.js` in full, the `miner_proofs` readers in `index.js` and `lib/db.js`, `requireBothProofs` + every `verifyOwnerProof` call site, the startup order, the two work guards in `lib/stratum-server.js`, `scripts/test-owner-gate.js` and the page's two renderers; KDF counts measured by a scratch harness, not reasoned. Three places were WRONG and are annotated in place (§17.2 #2/#3/#9, §17.4) with §17.7 holding the detail. Earlier the same day: **§17.6's Part 3 entry only**, read against the code that session: `migratePagesFromConfig` in `lib/db.js` (seed-once marker) and the `/restore` route in `index.js`. Before that: 2026-09-07, PARTIAL — **the multi-region surface only**, read against the code: the mode selector + `pool_mode_conflict_check` in `scripts/07_grin_mining_public_pool.sh`, `role`/`region`/`region_ports` in `back-end-pool/lib/config.js`, listener-port region stamping in `lib/stratum-server.js`, `shares.region` + `pool_locations` + `pool_region_metrics_hourly` in `lib/db.js`, the ingestion/health/region routes in `index.js`, and the WireGuard + region-port derivation in `scripts/lib/07_lib_gwctl.sh`. Everything outside that surface — the rest of §6, and §7–§10, §13–§15 — still rests on the 2026-06-08 pass (account + payout routes re-verified 2026-07-13) and was **not** re-checked, with one line-scoped exception: the admin-surface note in the §6 not-built list was corrected 2026-09-07 against `back-end-pool/admin-panel/` and `admin-shell.js`.
> **Product code last changed:** 2026-10-04 (§19.17 R2 review: games `lib/guests.js` — the per-name budget reserved before the scrypt await, the current-password check single-flight — and `lib/ratelimit.js` `refund`; before it, §19.17 Part C7: games `play/shell/**` (the chat core, the bubble, the shell hints) + `lib/app.js`; pool `public_html/js/branding.js`, `js/cms-frame.js` (new), `page.html`, `post.html`; before it, Part C6: games `play/shell/**` + `lib/http.js` messages + the pool admin `games.html` PoW label; before it, Part C5: games `lib/guests.js` + `lib/tickets.js` (new), `lib/db.js` (v5), `auth`, `sessions`, `chat`, `names`, `matches`, `moderation`, `leaderboard`, `events` + two kinds, `plays`, `pool-link`, `mask`, `settings`, `ledger`, `app`; admin `games-admin.js`, `games.html`, `games-players.html`, `games-chat.html`, `games-names.html`; `scripts/lib/07_lib_pool_games.sh`; uncommitted, not VPS-tested) · 2026-10-04 (§19.17 R1 review: `poolNameEntry` and two EXCEPTIONS in pool `lib/name-rule.js` + the games copy (identical code) + the shared fixture; uncommitted, not VPS-tested) · 2026-10-04 (§19.17 Part C4: pool `lib/name-rule.js` + the games copy (identical code) + the shared fixture, `lib/donor-profiles.js`, `lib/donor-names.js`, `lib/pool-settings.js`, `lib/db.js` (`banned_donor_names`), `index.js`, admin `donors.html` / `settings-names.html` / `index.html` / `admin-shell.js`, public `donate.html` / `account-settings.html`; uncommitted, not VPS-tested) · 2026-10-04 (§19.17 Part C3: games NEW `lib/name-rule.js`, `lib/names.js`, `lib/db.js` (v4), `lib/settings.js`, `lib/pool-link.js`, `lib/mode.js`, `lib/app.js`, `lib/moderation.js`, NEW `scripts/fixtures/name-rule.json`, `scripts/test-names.js`, `test-skeleton.js`, `test-shell.js`, `shell/index.html`, `shell/js/play-names.js`, `play-chat.js`; pool NEW `lib/name-rule.js`, `lib/pool-settings.js`, `lib/games-link.js`, `index.js` step-up list, NEW `admin-panel/settings-names.html`, `admin-shell.js`, `games-names.html`, `games-admin.js`, `games.html`, `games-players.html`, NEW `scripts/test-name-rule.js`, `test-games-link.js`, `test-admin-panel.js`, `package.json`) · 2026-10-04 (§19.17 Part C2: games `lib/mode.js`, `lib/app.js`, `lib/db.js`, NEW `scripts/test-launch.js`, `test-skeleton.js`; pool `lib/games-link.js`, `lib/pool-settings.js`, `public_html/js/public-shell.js`, `branding.js`, `admin-panel/games.html`, `settings-games.html`, `settings-common.js`, `scripts/test-games-link.js`, `test-public-leakage.js`; `scripts/lib/07_lib_pool_games.sh`; uncommitted, not VPS-tested) · 2026-10-04 (§19.17 Part C1, Option B: the eight files named above, plus NEW `scripts/test-operator-code-sinks.js`, `test-branding-sinks.js`, `test-admin-guards.js`, `test-admin-panel.js`, `package.json`; uncommitted, not VPS-tested) · 2026-10-03 (§20 R2 review fixes: `lib/node-availability.js`, `admin-panel/node-availability.html`, `scripts/test-node-availability.js`, `scripts/test-admin-panel.js`; uncommitted, not VPS-tested) · 2026-10-03 (§20 Part 8 homepage lamp: `fmtUpDays` + the `an-node` uptime row and hover in `public_html/js/reactor-dashboard.js`, `.lamp-up` in `reactor.css`, the `/api/pool/status` API reference row in `index.js`, test section [6]; uncommitted, not VPS-tested) · 2026-10-03 (§20 Part 7 admin page: NEW `admin-panel/node-availability.html` + its Dashboard nav row; uncommitted, not VPS-tested) · 2026-10-03 (§20 Part 6 node availability backend: NEW `lib/node-availability.js` + its test, `node_events` / `node_availability_meta` tables, the `auth` transport tag, `up_days` on `/api/pool/status`, two admin routes; uncommitted, not VPS-tested — implementation §10.15) · 2026-10-03 (admin Payouts split: `payments.html` → Queue, NEW `treasury.html` / `dormant.html` / `payouts-common.js`, payout request audit → `users.html` "Security"; front end only, uncommitted; reviewed 2026-10-03, its 4 low findings fixed the same day; not VPS-tested — impl §10.14) · 2026-09-28 (§19 Part 12 approved nicknames: NEW `play/server/lib/names.js` + `scripts/test-names.js`, migration v3 in `lib/db.js`, `nicknames_enabled` in `lib/settings.js`, `chatStatus` option + `/me` nickname in `auth.js`, `names.label` in `chat.js` / `leaderboard.js` / `events.js` / `matches.js`, ban ends the nickname in `moderation.js`, wiring + purge job in `app.js`; NEW `play/shell/js/play-names.js` + the Nickname fold; pool NEW `admin-panel/games-names.html`, the NAV entry, `games.html` / `games-players.html` / `games-admin.js` lines, `test-admin-panel.js` [15]; no pool backend code; **uncommitted, not VPS-tested**) · 2026-09-28 (§19 Part 11 review fixes: a free match writes no `results_daily` row + the matching void guard in `play/server/lib/matches.js`; global caps on the internal routes in `back-end-pool/lib/games-link.js`; the sign-in card's "someone else can sign in as you" line; the `plays.js` settings comment; the pool menu's B row; uncommitted, not VPS-tested) · 2026-09-28 (§19 Part 10: PvP seeks / challenges / draw / abort / timeout / rated pair cap / void in `play/server/lib/matches.js`, NEW `lib/ratings.js` + `scripts/test-pvp.js`, four PvP settings; NEW `play/shell/js/play-lobby.js` + the G-08 panel, PvP board buttons + polls, PvP boards; pool `games-players.html` void + `games.html` PvP group; no pool backend code; **uncommitted, not VPS-tested**) · earlier 2026-09-28 (§19 Parts 8–9: NEW `play/server/lib/{chat,moderation}.js` + `scripts/test-chat.js`, migration v2 in `lib/db.js`, the mining gate + `modStatus` in `auth.js`, chat settings, `/play/api/rules`; NEW `play/shell/js/play-chat.js` + the G-07 panel, `play:me` in `play-shell.js`; pool NEW `admin-panel/games.html`, `games-chat.html`, `games-players.html`, `games-admin.js` + the Games NAV group; no pool backend code) · earlier 2026-09-28 (§19 Part 7: NEW `play/server/lib/{leaderboard,events,admin,badges}.js` + `lib/events/{index,_rules,game_results,mining_minutes,active_days}.js` + `scripts/test-events.js`; `app.js` wiring + two jobs, a route `guard` in `http.js`, `checkSecret` in `pool-link.js`, `badges` on `/me`; NEW `play/shell/js/play-boards.js` + the G-06 panel; pool NEW `admin-panel/games-events.html` + the Games NAV group, `test-admin-panel.js` +11; no pool backend code; **uncommitted, not VPS-tested**). Same day as the next entry: 2026-09-27 (§19 Part 6: NEW `play/shell/**` (page, `play-api.js`, `frame-host.js`, `play-shell.js`, `play.css`) + `play/games/chess/frame/**` + games `scripts/test-shell.js`; pool `public_html/js/public-shell.js` site-absolute hrefs + no ads on exempt pages, `test-games-link.js` +4; `07_lib_pool_games.sh` stamps `__GRIN_PLAY_VERSION__`; **uncommitted, not VPS-tested**). Same day (§19 Part 5: NEW `play/server/lib/{registry,matches}.js`, `play/games/chess/{manifest.json,rules.js}` and `scripts/test-matches.js`; wiring in `lib/app.js`, two settings keys, ten message codes in `lib/http.js`; no pool code; **uncommitted, not VPS-tested**). Same day (§19 Part 4: NEW `play/server/lib/{pool-link,ratelimit,ledger,plays,sessions,auth,mode,settings,mask}.js` + `scripts/test-auth.js`, wiring in `lib/app.js` / `index.js`, `sameOriginOk` + error headers in `lib/http.js`; no pool code; **uncommitted, not VPS-tested**). Same day (§19 Part 3: the operator side — NEW `scripts/lib/07_lib_pool_games.sh` (menu `P`), the vhost's `/internal/` 404 + games glob include, games deploy in `9)`, games VACUUM in `C)`, cleanup group 1b/1c in the pool script; the games DB snapshot + separate restore in `07_lib_pool_backup.sh` / `07_lib_pool_migrate.sh`; impl §10.13 *Part 3*; **uncommitted, not VPS-tested**). Same day (§19 Part 2: the pool link — NEW `back-end-pool/lib/games-link.js` (three `/internal/games/*` routes, the `/api/admin/games/*` proxy, the 60 s probe), the `games` settings section, `games_port` / `games_link_secret_file` config defaults, `index.js` mount lines + the `games` step-up section + the branding `games` flag, the hidden Play nav item, NEW `admin-panel/settings-games.html`, NEW `scripts/test-games-link.js`; impl §10.13; **uncommitted, not VPS-tested**). Same day (§19 Part 1: the games service skeleton, NEW `web/07_mining_pool_public/play/` (`server/` + `README.md`), zero npm dependencies, nothing deploys it yet, the pool untouched; **uncommitted, not VPS-tested**). Same day (§15.5 Slatepack finalize binding: both finalize paths fail closed when the row or the reply has no slate id — scheduler only; impl §10.10 *Slatepack finalize binding*; **uncommitted, not VPS-tested**). Same day (§8 /review fixes #1–#6 — Held refunds wait for a resume and an intact wallet history, the Tor send holds the wallet send lock, grin-wallet's stdout reaches the settlement, the forced refund reads `tx_slate_state`, the send audit compares NET, a 360 s send timeout — scheduler, `lib/wallet-tor.js`, `lib/wallet.js` comment, `lib/reconciliation.js`, `index.js` audit row, admin `payments.html`; impl §10.10 *Review fixes*; **uncommitted, not VPS-tested**). 2026-09-26 (§8 Tor payouts: one attempt, Held, Tor pause, Slatepack offer; stepwise F5 and the retry ladder deleted; the `walletBin` fix for mainnet payout #10 — scheduler, `lib/wallet-tor.js`, `lib/wallet.js`, `lib/db.js`, settings, `lib/alert-monitor.js`, `lib/reconciliation.js`, `index.js`, the account page, four admin pages; impl §10.10; **uncommitted, not VPS-tested**). 2026-09-25 (slatepack rail: stored encrypted S1 + the §6 re-fetch route, refund-before-cancel expiry, `slate_cancel_pending` retry — security audit roll-up note "Slatepack rail: a lost tab…"; **uncommitted, not VPS-tested**). Same day (§8 / §8.1 Tor payout hardening F1–F5 + the CLI rail's exit-0 fallback fix — scheduler, `lib/wallet.js`, `lib/wallet-tor.js`, `lib/db.js`, settings, `index.js`, three admin pages; impl §10.8; **uncommitted, not VPS-tested**). 2026-09-24 (§13.13 hub move, review P1 — Migrate OUT removes the weekly VACUUM cron and refuses while a vacuum runs; `07_lib_pool_migrate.sh`). Same day (§18 Part 6 review fix R6-1 — `index.js` `requireBothProofs` refuses a proof verified as the other kind with `wrong_kind` instead of the verifier's success code `match`; the account page's `DP_REASONS` key follows; suite 1343 → 1345; **uncommitted, not VPS-tested**). Same day (§18 Part 5 — account page: P-05 donation row from `donation`, P-03 per-rig badge, NEW P-09 Donor profile panel in `account-settings.html`; the v1 aliases `donation_percent` / `donor_name` / `donor_name_state` dropped from `/api/account/:addr` and its api-docs row; suite 1331 → 1343; **uncommitted, not VPS-tested**). Same day (§18 Part 4 — `/api/pool/donors` v3: card `banner` under the Top-N slot rule, `ranking.banner_slots`, `current_percent` dropped; `donate.html` D-01 rewrite, D-01b, D-03 spotlight; api-docs row; suite 1310 → 1331; **uncommitted, not VPS-tested**). Same day (§18 Part 3 — admin review queue, image route, approve/reject/remove/block/unblock, `donors.html` rewrite, v1 censor/rescan/marker removed, wall + account names from approved profiles only, banner previews from a plain same-origin `src` (admin CSP unchanged); suite 1298 → 1310; **uncommitted, not VPS-tested**). Same day (§18 Part 2 — `donor_requests` + `donor_blocks`, NEW `lib/donor-profiles.js`, `leagueRank()`, `donor_banner_slots`, `requireBothProofs` purpose wording, three `/api/account/:addr/donor-profile` routes + account `donor_profile` in `index.js`; suite 1145 → 1298; **uncommitted, not VPS-tested**). Same day (§18 Part 1 — per-share donation in `lib/rewards.js` + `lib/incentives.js`, stored-% machinery removed, `liveDonations()` in `lib/donor-ledger.js`, additive fields on four `index.js` routes; suite 1134 → 1145; **uncommitted, not VPS-tested**). 2026-09-23 (Part 9 review fixes C1–C6 — dark gate, unit disabled across Migrate IN, code never archived/extracted, freeze on a failed extraction, no archive without pool.db, midnight-safe OUT; `07_lib_pool_migrate.sh`, `07_lib_pool_backup.sh`). Same day (hub move + connect-page latency, §13.13 — seeds v3 + local-region stamp in `lib/db.js`; NEW `lib/region-rtt.js`, `lib/connect-suggest.js`, `lib/latency-probe.js`; `/api/pool/connect/suggest`, `hub_rtt_ms`/`is_hub`, `connection.latency` on branding in `index.js`; `reactor-dashboard.js` + `reactor.css` measurement; gateway re-resolve timer + `6) Latency probe` in `07_lib_gateway.sh`; NEW `07_lib_pool_migrate.sh` + shared freeze/archive/restore cores in `07_lib_pool_backup.sh`; hub `/ping` + CSP in the pool script; suite 960 → 1133, 16 → 19 suites; **uncommitted, not VPS-tested**). Same day (payout-rails fix — `lib/wallet.js` `create_slatepack_message` named params; Tor probe ported from 06d in `lib/wallet-tor.js` + new `lib/socks5.js`, 8 s default, `?fresh=1` on tor-check; P-04 slimmed and the §17.2 #8 fold removed; suite 881 → 945; impl §10.5; **not VPS-tested**). Same day (§17 Part 4 review — `index.js`: `migrateProofSet` moved ahead of `stratumServer.start()`, `proof_too_recent`/`anchor_not_accepted_here` texts; `lib/owner-proof.js`: racing duplicate capture no longer evicts a second proof, a returning evicted anchor restarts `first_seen_at`; `test-owner-gate.js` 36 → 42, suite 875 → 881; **not VPS-tested**, §17.7). Same day (§17 Part 3 — copy sweep, no logic: the homepage setup guide, the shipped Terms/Privacy/FAQ defaults in `lib/pool-settings.js`, the `anchor_not_accepted_here` error text + two `index.js` doc/comment sites, and stratum/owner-proof/db comments restated for a set of ten; suite unchanged at 875/875; §17.6 Part 3). 2026-09-22 (§17 Part 2 built — the account page: `public_html/account-settings.html` renders `proofs` as counts, drops the "Evidence changed" banner, warns only past the cap and restates the gate copy for a set of ten; **not VPS-tested**, impl §10.4 "Part 2", §17.6 records the deltas). Same day (§17 Part 1 built — the ownership-proof SET backend: `miner_proofs` + `miner_accounts.proof_salt`, per-address scrypt salt, set capture/verify with LRU eviction and a flagged-not-deleted anchor, `migrateProofSet()` replacing `migrateOwnerProofHashes` and `backfillProofAnchors`, `proofs` on the account and admin miner views, suite 849 → 875; **not VPS-tested**, impl §10.4, §17.6 records the deltas). 2026-09-21 (§16 Part 5 review: two fixes in `lib/donor-names.js` — the rescan parses the list once per walk, not per name, and a separators-only label is no label — §16.12; the same day Parts 1–4 were built in order: login grammar → storage + capture + account view → admin moderation → the public league, impl §10.3 "Part 1"–"Part 4", every part **not VPS-tested**; earlier the same day: `/api/pool/donors` totals over every donor + `active_donors` from live tags, account `is_online` per rig — impl §10.3). 2026-09-20: pairing string carries the public port; gateway Status boot line, §13.12s; anchored ufw test + unmanaged-firewall readout, §13.12t — `scripts/07_grin_mining_*.sh`, `scripts/lib/07_lib_*.sh`, `web/07_mining_pool_public/`
> Prose last edited 2026-10-04 (§19 v2 R2 review: §19.15 *R2 review*, the §19.14 R2 row, the §19 / §19.17 headings) · 2026-10-04 (§19 v2 Part C7: §19.15 *Part C7*, the §19.14 C7 row, the §19.17 heading, the §19.17.7 as-built pointer) · 2026-10-04 (§19 v2 Part C5: §19.15 *Part C5*, the §19.14 C5 row, the §19.4 v5 SQL + heading, the §19 / §19.17 headings) · 2026-10-04 (§19 v2 R1 review: §19.15 *R1 review*, the §19.14 R1 row, the §19 / §19.17 headings, the §19.17.5 pool-name pointer) · 2026-10-04 (§19 v2 Part C4: §19.15 *Part C4*, the §19.14 C4 row, the §19 / §19.17 headings, the §19.17.6 pointer, the §18 note and the §18.11 pointer; before it, Part C3: §19.15 *Part C3*, the §19.14 C3 row, the §19.4 v4 SQL, §19.16's superseded note, §19.17.5's moderator route + schema-sketch pointers, the §19 and §19.17 headings) · 2026-10-04 (§19 v2 Part C2: §19.15 *Part C2*, the §19.14 C2 row + status note, the §19.3 health line + default cells, the §19 and §19.17 headings) · 2026-10-04 (§19 v2 Part C1: §19.15 *Part C1*, the §19.14 C1 row, the §19 and §19.17 headings) · 2026-10-03 (§19 v2 Part C0: NEW §19.17 — D22–D32, launch state, guest accounts, tickets, names v2, donor names, the chat bubble, the Community header group, settings; D8/D9/D10/D12/D19/D21 amended in place; the §19.3 defaults cells; §19.16 marked superseded; §19.13 #22–#30; §19.14 rows C0–C9/R1/R2 and Part 13 → C9; O1 closed by D22 in §19.15 *Part 11 review*; the §19 heading) · 2026-10-03 (Part 9 docs fold: the §20.5–§20.8 as-built notes moved to implementation §10.15, pointers left in §20.5, §20.6 and a new §20.7–20.8 stub; header) · 2026-10-03 (§20 R2 review: NEW §20.8, the §20.7 state table rows `unobserved` + `info`) · 2026-10-03 (§20 Part 8 built: §20 heading, the §20.5 *Part 8 as built* note) · 2026-10-03 (§20 Part 6 built: §20 heading, NEW §20.7 as-built deltas) · 2026-10-03 (§20 Node availability added — design only, no code) · 2026-09-28 (§19 Part 11 review: §19 heading, §19.6 settings paragraph, §19.8 free-match sentence, §19.14 Part 11 row + closing line, §19.15 *Part 11 review*). 2026-09-28 (§19 Part 10 built: §19 heading, §19.6 PvP cost, §19.8 resign/abort + rated scope + routes, §19.11 rows, §19.14 Part 10 row + closing line, §19.15 *Part 10*). 2026-09-28 (§19 Parts 8–9 built: §19 heading, D21, §19.4 v2 tables, §19.10 report + change feed + moderators, §19.11 rows + FAST-list note, §19.14 Part 8–9 rows + closing line, §19.15 *Part 8* (15 deltas) and *Part 9* (10 deltas)). 2026-09-28 (§19 Part 7 built: §19 heading, §19.9 `reward_json` line, §19.11 `games-events.html` row, §19.14 Part 7 row + closing line, §19.15 *Part 7* with 15 deltas). 2026-09-27 (§19 Part 6 built: §19 heading, §19.14 Part 6 row + closing line, §19.15 *Part 6* with 14 deltas; the file de-duplicated, see *Last verified*). Same day (§19 Part 5 built: §19 heading, §19.6 points note, §19.14 Part 5 row + closing line, §19.15 *Part 5* with 13 deltas). Same day (§19 Part 4 built: §19 heading, §19.14 Part 4 + checkpoint A rows + closing line, §19.15 *Part 4* with 14 deltas). Same day (§19 Part 3 built: §19 heading, §19.12 *As built* note, §19.14 Part 3 row + closing line, §19.15 *Part 3* with 13 deltas). Same day (§19 Part 1 built: §19 heading, §19.14 Part 1 row + closing line, §19.15 *Part 1* with 12 deltas). Same day (§19 added — games platform `/play/`: separate `grin-games` service + `grinium-games.db`, the pool link contract, chess vs bot then PvP correspondence, events, moderated chat; design only, NOT built; D18–D20 answered by the operator that day). Same day (admin route catalog: `GET /api/admin/miners/:addr/workers` added — impl §10.12). Same day (binding fix: §15.5's "Response binding" bullet says the bind fails closed). Same day (/review fixes: §8's "Why this is safe" gains the wallet-history proviso, NEW "One send at a time" bullet, "Held resolves itself" and "The operator" amended). 2026-09-26 (one-attempt Tor payout fold: §8's opening line, Tor row and no-auto-payout paragraph; the balance table gains Held; the ladder sentence and "What moves a Tor payout on" replaced by "One Tor attempt, then an answer" with the rejected auto-Slatepack alternative; two sentences on the pre-flight probe; §8.1 heading → DELETED + a new status note). 2026-09-25 (Tor payout hardening fold: §8's Tor row, the stale Auto-payout paragraph replaced by "There is no auto-payout", NEW paragraphs on uncounted retries and "paid is not mined", §8.1 heading → BUILT behind the switch + a status note, §8.1.1's bug annotated as fixed on the CLI rail). Earlier the same day (§8.1 added — step-by-step Tor send design, F5, NOT built; it also records that today's CLI rail marks an undelivered Tor send as paid). 2026-09-24 (§18 Part 6 review: §18 heading, §18.10 Part 6 row, NEW §18.11 *Part 6*, Part 5 #10 annotated). Same day (§18 Part 5 built: §18 heading, §18.10 Part 5 row, §18.11 *Part 5*). Same day (§18 Part 4 built: §18 heading, §18.10 Part 4 row, §18.11 *Part 4*). Same day (§18 Part 3 built: §18 heading, §18.10 Part 3 row, §18.11 *Part 3*). Same day (§18 Part 2 built: §18 heading, §18.10 Part 2 row, §18.11 *Part 2*). Same day (§18 Part 1 built: §18 heading, §18.10 Part 1 row, NEW §18.11 build deltas). 2026-09-23 (§13.13 added — hub move + connect-page latency; §4 gained the effective-latency rule; §11 the gateway :443 probe note; §13.10b/c annotated where a hub IP change was said to need no gateway action). Earlier the same day (§18 added — donations v2: per-share donation, reviewed donor profiles with nickname + top-5 banner; design only, NOT built; §16 marked superseded in part and its Part 6 replaced by §18.10 Part 7). Earlier the same day (payout-rails fix: §8 gained the Tor pre-flight probe paragraph, replacing a "no TCP port-probe before send" claim that had been false since 2026-07-19; §17.2 #8 annotated where the operator reversed the fold placement). Earlier the same day (§17.7 added — the Part 4 review's ten answers and three fixes; §17.2 #2/#3/#9, §17.3 and §17.4 annotated where the review found them wrong; §17.6 Part 4 done). Earlier the same day (§17 intro + §17.6 — Part 3 done, with its three deltas, incl. that already-installed pools keep the old CMS page text; §6's slatepack note pointed at §17). 2026-09-22 (§17.6 updated — Parts 1 (backend) and 2 (account page) are built, with each part's deltas from §17 recorded there; Parts 3–5 unrun. Earlier the same day: §17 added — ownership-proof SET of 10 per kind with a per-address salt, replacing the 2-slot window). 2026-09-21 (§16 added — donor names + donor league; §16.11 tracks the build, Parts 1–5 done, Part 6 = VPS acceptance still owed; §16.12 records what building changed against the design and the Part 5 review's findings).

**Product:** `scripts/07_grin_mining_public_pool.sh` + web app under `web/07_mining_pool_public/`.
**Scope:** the complete public-pool design — architecture, deployment modes, multi-region
(Model C gateways), database, API, reward pipeline, payments, white-label, and UI/UX.

> **Companion docs (max-3 convention):**
> [`script07_implementation.md`](script07_implementation.md) — deploy, runbook, status, troubleshooting ·
> [`script07_security_audit.md`](script07_security_audit.md) — vulnerabilities, hardening, fixes.
> The **solo** miner (`07_grin_mining_solo.sh`) is a separate product —
> see the solo flowchart appendix at the end of this file.
>
> This file absorbs the former `script07_multi_region_design.md` and the imported
> `script07_public_pool/` GRINIUM doc set (deleted 2026-06-08). Where those described the
> standalone **Grinium** repo (`web/back-end-pool/`, ports `3002/3416`), this doc uses the
> **toolkit** layout (`web/07_mining_pool_public/`, ports `3333/3416/8080`).

---

## 1. What it is

A self-hostable **public mining pool for Grin**. The toolkit deploys the node (Script 01);
Script 07 deploys the full pool stack on top of a running node + grin-wallet.

- **Model:** address-as-identity (2miners style) — a miner's Grin address *is* their login
  (`grin_address.worker_name` as the stratum username). No miner registration/accounts.
- **Rewards:** PPLNS (default; configurable to Proportional or Solo via admin panel).
- **Auth:** admin-only JWT sessions. Miners never authenticate.
- **Script 07 role:** **infrastructure only** — deploy files, systemd, nginx, backups. All
  business logic lives in the pool web code; all settings are set via the web admin panel
  (config in `/opt/grin/conf/grin_pubpool.json`), never bash config files.

### Stack reality — Express, not Next.js
An earlier "v4" plan to rewrite in Next.js + Tailwind **never happened**. Treat any
"Next.js / Tailwind / App Router" mention in old notes as an abandoned proposal. The live
stack is:

| Layer | What's in the repo |
|---|---|
| Backend | **Express** (`back-end-pool/index.js`), one long-lived process per network |
| Frontend | **Static HTML + vanilla JS** (`public_html/*.html`, `js/*.js`), served by nginx |
| Styling | `public_html/css/pool.css` + `js/theme.js` (CSS variables) |
| Database | **SQLite** via Node's built-in `node:sqlite` (synchronous, in-process; `lib/sqlite-compat.js` shim keeps the better-sqlite3-style API; needs Node 24+) |
| Process mgr | **systemd** (+ watchdog cron) |

---

## 2. Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ Nginx (reverse proxy, HTTPS via certbot)                      │
│  • serves static frontend  (public_html → /var/www/…)         │
│  • /api/* → Express backend (localhost :8080)                 │
│  • security headers, rate-limit zones (shared helper)         │
└───────────────────────────────┬──────────────────────────────┘
                                 ▼
┌──────────────────────────────────────────────────────────────┐
│ Express backend  (back-end-pool/index.js)                     │
│  HTTP API (:8080) + Stratum TCP server (:3333), one process   │
│  lib/: auth · stratum-server/-protocol · node-stratum-client  │
│   shares · miners · blocks · block-monitor · rewards (PPLNS)  │
│   orphan-detector · hashrate-tracker · wallet · wallet-tor    │
│   withdrawal-scheduler · pool-settings · rate-limiter         │
│   ip-filter · alert-monitor/-delivery · asset-manager         │
│   incentives · lottery · retention · reconciliation           │
└───────────────────────────────┬──────────────────────────────┘
                                 ▼
┌──────────────────────────────────────────────────────────────┐
│ SQLite (node:sqlite)  /opt/grin/pubpool/<net>/pool.sqlite     │
│  miner_accounts · shares · blocks · withdrawals · balance_log │
│  withdrawal_events · users · admin_audit_log · pool_settings  │
│  pool_locations · hashrate_history · miner_incentives ·       │
│  lottery_draws · lottery_winners                              │
└───────────────────────────────┬──────────────────────────────┘
                                 ▼
        Grin node (Owner+Foreign API) · grin-wallet · Tor
```

One backend process per network; mainnet and testnet run fully isolated (separate dirs,
ports, services, DB files). `--testnet` flag (never `--floonet`); currency label `tGRIN`
vs `GRIN` via a config helper.

### Request / money flow
```
Miner ── stratum ──▶ proxy validates share ──▶ shares table
                                                  │
Pool finds a block ──▶ blocks (status=pending, nonce, height, reward)
                                                  │
        confirm_depth reached (1440 mainnet / 100 testnet)
                                                  │
        orphan check (nonce still in chain?) ──▶ if orphan: reverse exact credits
                                                  │ else confirm
                                  PPLNS distribute ──▶ miner_accounts.balance
                                                  │
        balance ≥ threshold / manual ──▶ withdrawal (Tor or Slatepack)
                                                  │
                                  grin-wallet send ──▶ Grin network
```
Every balance change writes an append-only `balance_log` row; every withdrawal state change
writes a `withdrawal_events` row.

---

## 3. Deployment modes

Script 07 has a **mode selector**. Two modes are offered on the menu; a third is arg-only.
A mode may also be passed non-interactively as `$1` (`singlebox` | `hub` | `gateway`).

```
Public Mining Pool Deployment Mode — <network>
  1) Pool server      The pool itself — runs everything. Start here.
                      Serves local miners as region "main"; accepts regional
                      gateways from other zones later — no rebuild.
  2) Regional gateway A thin stratum forwarder on ANOTHER box: no node,
                      no wallet — tunnels miners to your pool server.
  Z) Cleanup public pool        0) Back to mining hub
```

| Mode | Arg | Deploys | Library | Config file |
|---|---|---|---|---|
| **Pool server** | `singlebox` | Everything on one box: Central API (sole DB writer) + SQLite/WAL + schema + retention + web dashboard + admin + wallet (Tor/Slatepack payouts) + nginx + the **public** stratum listener | core `pool_*` fns (`pool_singlebox_loop`) | `grin_pubpool.json` · testnet `grin_pubpool_testnet.json` |
| **Regional gateway** | `gateway` | HAProxy (`mode tcp`) + WireGuard **only** — no Node process, no node, no wallet, no DB, no keys | `scripts/lib/07_lib_gateway.sh` | `grin_gateway.json` |
| **Central Hub** *(arg-only)* | `hub` | The same brain, without a local public stratum — all mining arrives via gateways | `scripts/lib/07_lib_hub.sh` | `grin_pubpool.json` |

`config.js` selects the app role via the `role` key — **`singlebox` | `hub`, and nothing else.**
A **regional gateway is not an app role**: it runs no Node process, so it never reads `role`.
`pool_mode_conflict_check` refuses to put a pool server/hub and a gateway on the same box —
both want stratum `:3333`, so it is one mining role per box.

WireGuard peers and the central `region_ports` map are mutated through exactly one path,
`grin-gateway-ctl` (`scripts/lib/07_lib_gwctl.sh`), shared by the CLI (`W` menu) and the admin
panel so the two can never drift apart. See §13 for that pairing flow.

---

## 4. Multi-region — why SQLite stays, and how regions attach

> This section is the **why**. The as-built account — bring-up order, scenario matrix, smoke
> tests — is §8 "Multi-region (Model C) — as built" of
> [`script07_implementation.md`](script07_implementation.md).
> **Multi-region is optional and most pools never need it:** one pool box already serves every
> miner on `:3333` as region `main`. Add a gateway only to cut latency for miners on another
> continent.

### Single-writer by design
Trace every arrow that reaches the DB: there is exactly **one** — the central pool process → DB.
Gateways, nodes and stratum listeners never open the database. Several regions can feed shares in,
but every path converges on **one process**, and only that process writes.

```
Miners (Asia) ─▶ Asia Gateway ─┐  WireGuard: raw stratum + PROXY-v2
Miners (US)   ─▶ US Gateway   ─┼─▶ region listeners 10.66.66.1:3391, :3392 … ─┐
                               │                                              ├─▶ pool process ──▶ SQLite (WAL)
Miners (local) ── stratum :3333 ──▶ public listener ───────────────────────────┘    (single writer)        ▲
                                                                                                           │
                                                                       Dashboard ── reads ─────────────────┘
```

"Concurrent load from 3 regions" is **connection** concurrency at the TCP/HTTP layer (Node's event
loop), not **database-writer** concurrency. SQLite WAL gives one writer + unlimited concurrent
readers, 100k+ batched inserts/sec (vs ~100 shares/sec for a 1,000-miner pool), and single-file
backup.

**That argument survived the Model C refactor — and got stronger, so it is kept here, not merely
inherited.** Its pre-2026-06 form was *"adding a satellite is a new HTTP client, not a new DB
writer."* Under Model C a region is not even a new client: it is **a new TCP listener inside the
same process**, bound to the WireGuard interface. The old form leaned on a *discipline* (a relay
must POST and never touch the DB file) that a future contributor could break; the new one is
*structural* — a gateway ships no code that could open a database, because it ships no Node at
all. The conclusion is unchanged and now harder to violate: **adding a region does not add a DB
writer, so SQLite keeps fitting.**

**Migrate to PostgreSQL only if the topology changes** so the DB stops having a single writer: the
pool process goes multi-process/replicated behind an LB; the DB moves onto a separate box (SQLite
has no network protocol — NFS/SMB breaks its locking); sustained >10k durable shares/sec; hot
relational data >~20–50 GB; or you need multi-master/hot-standby. **Never MariaDB.**

PRAGMAs at DB creation: `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`,
`foreign_keys=ON` (file space reclaimed by the weekly `VACUUM` cron — Script 07 option C).

### Share capture = our own stratum proxy (not log-tailing)
In Grin the node's stratum is integrated with no clean external `getblocktemplate`, so the practical
"own server" is a **stratum proxy in front of the node's built-in stratum** (the proven `grin-pool`
model). Ours is not a separate daemon: `lib/stratum-server.js` (miner-facing) and
`lib/node-stratum-client.js` (node-facing) both run **inside the pool process**, so recording a
share is an in-process call, never a network hop:

```
Miners ──stratum──▶ stratum-server.js ──▶ accounting ──▶ pool.sqlite
                          │
                          └── node-stratum-client.js ──stratum──▶ node built-in stratum (localhost)
```

It binds the **public** stratum port (`3333` / testnet `13333`); the node's built-in stratum binds
**localhost only** (`3416` / testnet `13416` — grin's own `stratum_server_addr` default, which the
toolkit never moves). It sees every `login`/`submit` as structured JSON → reliable
`address.worker` identity + difficulty + nonce + timestamp, per-miner **vardiff**, dedup by
`(nonce, height)`, rate-limits, and abuse bans. Log-tailing was **rejected** (brittle format, one
global difficulty, no guaranteed per-share identity).

### Region attribution is by listener PORT, not by a string the edge sends
Each gateway's WireGuard tunnel targets **its own** central listener port — `region_ports`, a
`{ "<region>": <port> }` map in the pool config, allocated from a per-network base (`3391`
mainnet / `13391` testnet) by `grin-gateway-ctl`. `stratum-server.js` binds one listener per entry
on `region_listen_host` — **the WireGuard server IP in production**, defaulting to loopback so a
misconfigured box fails closed instead of exposing an unauthenticated port — and stamps that
listener's static label on every share arriving on it.

That is a security property, not just plumbing. The region tag is **server-derived and
unspoofable**: nothing a miner or a compromised edge sends can change it, which removes the old
"the region string the relay sends must match the hub's" footgun outright. PROXY-protocol v2
(which recovers the real miner IP behind the tunnel) is armed on **region listeners only**, so the
public `:3333` can never be fed a forged header. Conversely the per-IP connection cap applies to
the public listener only — a region tunnel is trusted, and one peer IP fronts a whole region.

`StratumServer.bindRegionListener(region, port)` adds a listener at runtime, so pairing a gateway
from the admin panel takes effect with **no restart and no miner disruption** (§13.3). Removing a
peer does not hot-unbind: that listener simply goes idle until the next natural restart.

### A gateway does not shorten the trip to the hub (effective latency)
A gateway ends the miner's **TCP connection**. It does not end the **share's journey**: every
share still crosses gateway → hub before it is validated and counted, and every job still comes
back the same way. So what a miner feels is the **effective** latency:

```
via a gateway = miner → gateway + gateway → hub
direct        = miner → hub
```

A nearby gateway can therefore be *slower* than no gateway. The case that made this concrete
(2026-09-23, Globalping, hub moving to OVH Gravelines): Singapore → Gravelines direct measured
148–162 ms, while Hong Kong → Europe varied from 159 to ~250 ms **depending only on the HK
provider's route** — so a Singapore miner sent to an HK gateway could lose 100 ms. The EU
datacenter choice (Gravelines vs Strasbourg) was worth ~1–15 ms; the gateway provider's route
was worth ~100 ms.

Two rules follow, and both are built (§13.13): the connect page ranks by effective latency, never
by distance to the nearest box; and **direct wins a near-tie** — a gateway must beat the hub by
more than 15 ms to be recommended, because it is one more trusted box in the path (it vouches for
the miner's IP — audit §J16-2) and one more thing that can go down. Put a gateway where the
gateway→hub leg is short and well-routed, not merely where miners are.

---

## 5. Database schema

> **Authoritative source = `back-end-pool/lib/db.js` (`createSchema()`).** The live schema keys
> tables by `grin_address` (not `miner_id`), stores balances as **`REAL` GRIN** (not nanogrin
> integers), and uses a single-resolution `hashrate_history`. The idealized integer-nanoGRIN /
> downsampled model in older notes is a *conceptual target*, not the current code.

Core tables (`/opt/grin/pubpool/<net>/pool.sqlite`):

| Table | Purpose | Retention |
|---|---|---|
| `miner_accounts` | balance, balance_locked, total_paid, is_online, location — keyed by `grin_address` | live |
| `shares` | PPLNS input (grin_address, worker, difficulty, block_height, **region**, created_at) — `region` is the **listener label**, stamped by whichever stratum listener accepted the connection (public listener → `config.region`, default `'default'`/`main`; a per-region tunnel listener → that region's key). It is server-derived, never client-asserted, and drives per-region stats only; PPLNS weighting is region-agnostic. Legacy rows predating the column read `'default'`. | sliding window (pruned) |
| `blocks` | found blocks + maturity (height, hash, nonce, reward, status, found_by) | forever |
| `withdrawals` | payouts (amount, fee, method tor\|slatepack, status, retry_count, txid) | forever |
| `balance_log` | append-only ledger of every balance/locked change | raw window `balance_log_keep_days` (default 60, floor 45) — rolled into `balance_log_daily` first; see §14 |
| `balance_log_daily` | daily rollup of the ledger — (UTC day, address, event_type, reference_type) → total_amount, event_count | **forever** (≈150 MB/10 yr @1000 miners) |
| `withdrawal_events` | per-withdrawal state-transition log | forever |
| `users` | admin accounts only (bcrypt, lockout columns) | forever |
| `admin_audit_log` | every admin mutation (admin_id, action, target, before/after, ip) | forever |
| `pool_settings` | runtime config overrides editable via admin UI (key/value/value_type) | live |
| `pool_locations` | operator-declared regions (region UNIQUE, label, api_url, stratum_url, is_active) — **purely descriptive**: labels + public stratum URLs for the "point your rig at your nearest region" grid, left-joined onto live share aggregates by `region`. A row here grants nothing; the real region wiring is the WireGuard peer + `region_ports` entry created by `grin-gateway-ctl`, and this box self-registers its own region via `ensureLocalRegion()`. | live |
| `hashrate_history` | timeseries + per-region aggregates | pruned by age |
| `pool_region_metrics_hourly` | one row per (hour, region) — hashrate/miner counts aggregated from `shares.region`; backs the public per-region trend charts | durable (bounded by region count) |
| `miner_incentives` | per-address join_bonus_paid, donation_percent, streak_days | live |
| `lottery_draws` / `lottery_winners` | verifiable lottery state | forever |

`pool_fee` and `prize_pool` are **reserved pseudo-addresses** (rows in `miner_accounts`) filtered
out of every miner-facing surface. Money flows through `balance_log` for audit.

---

## 6. API catalog (Express routes)

> **Verified against `back-end-pool/index.js` (2026-06-08; account + payout routes re-verified 2026-07-13;
> the ingestion / `health/*` / region routes re-verified 2026-09-07).** ✅ = wired in the backend ·
> ❌ = documented target, not yet built (see "Not yet implemented" below). Paths are the
> *actual* registered routes — earlier drafts of this catalog overstated the surface.

**Public — no auth (address is identity):**
```
✅ GET  /health  |  /api/health                         (alias; nginx proxies /api/*)
✅ GET  /api/pool/stats | /api/pool/stats/regions | /api/pool/blocks | /api/pool/payments
✅ GET  /api/pool/miners (balance distribution, addresses MASKED) | /api/pool/locations
✅ GET  /api/stratum/stats | /api/stratum/hashrate | /api/config/pool-info
✅ GET  /api/account/:addr | /:addr/balance/log | /:addr/shares | /:addr/tor-check
❌ GET  /api/miners/top | /api/account/:addr/balance   REMOVED 2026-07-28 (rich-list / duplicate;
        see script07_security_audit.md §C1). The live list is always /api/public/endpoints.
✅ GET  /api/account/:addr/workers | /:addr/hashrate/history
✅ POST /api/account/:addr/withdraw   { amount?, method?, ip_proof? }   (Tor auto; Slatepack IP-gated)   [IMPLEMENTED 2026-07]
✅ POST /api/account/:addr/withdraw/:id/finalize   { response_slatepack, ip_proof }   (Slatepack S2 finalize)   [IMPLEMENTED 2026-07]
✅ POST /api/account/:addr/withdraw/:id/slatepack   { proof }   (the SAME stored S1 again, pending manual rail only)   [IMPLEMENTED 2026-09-25]
✅ POST /api/account/:addr/min-payout   { min_payout, ip_proof }   (per-miner threshold; IP-gated, ≥ pool min)   [IMPLEMENTED 2026-07]
✅ GET  /api/public/branding | /public/page/:key | /public/lottery/winners
✅ GET  /robots.txt | /sitemap.xml | /manifest.json     (dynamic, exact-match nginx proxies)
⚠ /api/claim/:id?token=…   — claim-token route SUPERSEDED (never built); Slatepack payout now ships via the
                              IP-gated account self-service flow above (§8), not a claim link
```

**Ingestion: there is none — and that is the design.**
```
❌ POST /api/shares | /api/blocks   REMOVED 2026-06-22 (f2ebade) with the satellite role.
```
Regional gateways forward **raw stratum over WireGuard**, not shares over HTTP, so there is no
share/block ingestion API, no `hub_shared_secret`, and no ingestion allowlist to get wrong. Every
share is recorded by the central stratum server exactly like a local miner's (§4). Per-region
liveness is derived from recent shares plus a best-effort WireGuard handshake age, and served at
`/api/admin/health/gateways`.

Public region surface (no auth):
```
✅ GET  /api/pool/stats/regions | /api/pool/metrics/history/regions
✅ GET  /api/pool/topology        (404 unless the operator has enabled the public network map)
```
`/stats/regions` and `/metrics/history/regions` apply a **k-anonymity floor**: a region with
`0 < miners < min_bucket` reports `miners` / `hashrate_gps` / `shares_window` as `null` with
`below_floor:true`. That is *withheld*, not zero — a real zero is still `0`, and a chart must draw
a `null` as a **gap**, never as `0`. Totals stay exact.

**Admin auth (admin register is CLI-only):**
```
✅ POST /api/auth/login | /refresh | /logout | /change-password
❌ POST /api/auth/reauth     ❌ GET /api/auth/me        (fresh-reauth/whoami — NOT built)
```

**Admin (`requireAdmin` = rate-limit + IP filter + JWT):**
```
✅ GET  /api/admin/dashboard | /metrics | /audit-log
✅ GET  /api/admin/health  (roll-up)  |  /health/node | /health/wallet | /health/system | /health/gateways
✅ GET  /api/admin/miners | /miners/:addr | /miners/:addr/workers  [2026-09-27, impl §10.12]     POST /api/admin/miners/:addr/inject  (testnet only)
✅ GET  /api/admin/withdrawals | /withdrawal-scheduler
✅ GET/POST/DELETE /api/admin/locations[/:id]
✅ GET/POST /api/admin/settings | /settings/:section | /settings/:section/restore
✅ GET/POST /api/admin/database/status | /database/cleanup
✅ GET  /api/admin/alerts | /alerts/:id/acknowledge | /snooze | /config
✅ POST /api/admin/assets/upload | GET /assets | DELETE /assets/:filename
✅ GET/POST /api/admin/incentives/prize-pool[/topup] | /incentives/lottery/draws|draw-now
✅ GET/POST /api/admin/security/* | /poolstats/*
❌ PUT  /api/admin/miners/:addr                         (admin edit of a miner — NOT built)
✅ POST /api/admin/withdrawals/:id/cancel  (freshAdmin)   [IMPLEMENTED]   ❌ GET /…/:id/events  (NOT built)
✅ POST /api/admin/withdrawals/:id/recheck (secureAdmin) | /force-refund (freshAdmin + confirm_id)   [2026-09-26, Held Tor rows]
🗑 POST /api/admin/withdrawals/:id/retry                (REMOVED 2026-09-26 — answers 410 with a reason)
✅ POST /api/admin/miners/:addr/tor-pause/clear  (freshAdmin)   [2026-09-26]
❌ GET/PUT /api/admin/users[/:id]                       (admin user CRUD — NOT built; create via CLI)
❌ GET  /api/admin/payment-stats                        (reconciliation page API — NOT built)
```

### Not yet implemented (doc-vs-code, 2026-06-08)
These remain **documented targets without backend routes**; tracked so the catalog stays honest:
- **Slatepack claim** (`/api/claim/:id`) — the *claim-token route shape* was superseded and never
  built. The Slatepack payout **rail itself IS now wired** (2026-07) via the account self-service flow
  (`POST /api/account/:addr/withdraw` method=slatepack → `/withdraw/:id/finalize`), IP-gated + encrypted
  to the miner address (§8). Tor is **no longer** the only wired payout rail.
- **Admin user CRUD** (`/api/admin/users[/:id]`) — NOT built (create via CLI). Manual withdrawal
  `retry`/`cancel` **ARE now built** (`freshAdmin`-gated); only the `/…/:id/events` timeline is missing.
  `back-end-pool/admin-panel/users.html` (nav title **Security**) references user-CRUD, but nothing
  else in the panel depends on it. There is no `public_html/admin-dashboard.html` — the admin surface
  is `back-end-pool/admin-panel/`, rsynced to the web root's `/admin/` at install.
- **`/api/admin/miners/:addr` PUT**, **`/api/auth/reauth` + `/me`**, **`/api/admin/payment-stats`**.

---

## 7. Reward pipeline (PPLNS)

```
1. The stratum server detects a found block → blocks(status=pending, nonce, height, reward)
   - always local: BlockManager.creditBlock on this box (dedups by `hash` UNIQUE).
     Under Model C there is only ever one node + one wallet, so a share arriving over a
     region tunnel credits by exactly the same path as a local one.
2. block-monitor (each tick): tip_height − block.height ≥ confirm_depth ?
3. orphan-detector: is the block's nonce still in the chain?  no → orphan+reverse · yes → confirmed
4. rewards.distributeConfirmedBlocks: PPLNS over the last-N-blocks share window
5. withdrawal-scheduler pays out when balance ≥ threshold (Tor / Slatepack)
```

- **`confirm_depth` = 1440 mainnet / 100 testnet** — equals Grin `COINBASE_MATURITY = 1440`
  (a coinbase is unspendable until 1440 confirmations); critical for reorg safety. Validated
  against `grin-pool` / `open-grin-pool`.
- **Double-pay guard:** distributed shares are marked paid (per-block) inside the distribution
  transaction so overlapping windows can't pay a share twice.
- **Fee routing:** `fee = gross − net`; credited to the `pool_fee` pseudo-address. Default
  `pool_fee_percent` is **1.0** (`config.js`, `pool-settings.js`, and the bash
  installers all agree); operator-editable via the admin panel.
- **The pool fee is taken at BLOCK MATURITY, never at withdrawal** — and that is a correctness
  choice, not a convenience one (revisited and re-affirmed 2026-07-27). Block reward is the only
  correct fee base: (1) orphan reversal replays the exact `balance_log` credits *including* the
  fee, so a fee already banked at withdrawal time would be unrecoverable once the miner had
  withdrawn; (2) charging at the withdrawal door would tax the pool's own giveaways (join bonus,
  streak, prize awards) on the way out while letting a dormant-swept balance escape fee-free;
  (3) a later `pool_fee_percent` change would apply retroactively to GRIN mined under the old
  rate; (4) displayed balances stay equal to what the miner receives, so `min_withdrawal` and
  every account/ledger surface mean exactly what they say.
- **Orphan reversal** reads the *actual* credited amounts from `balance_log` and reverses those
  exact values (PPLNS-weighted, including the fee credit); never pushes a balance below 0.
- **Payout threshold:** default `min_withdrawal` = **25 GRIN** (raised from 5.0 on 2026-07-13; agrees
  across `config.js`, `pool-settings.js`, admin `settings-payout.html`, and the
  bash installer). Rationale: each payout is an interactive tx that adds a **permanent kernel** to the
  chain, so a low floor multiplies both chain growth and pool payout load. Operator-editable in the
  admin panel. Each miner may set a personal `min_payout` override (IP-gated
  `POST /api/account/:addr/min-payout`) that can only **raise** the floor — enforced at write time and
  re-checked in `withdrawal-scheduler.js`, so an override never drops a payout below the pool minimum.
- **Flat withdrawal fee:** default `withdrawal_fee` = **0.04 GRIN** (added 2026-07-27; `config.js`,
  `pool-settings.js`, admin `settings-payout.html`). Deducted from every payout on **all three
  rails**; `0` makes the pool absorb the cost. Grin charges the **sender** a network fee by
  transaction *weight* — `(inputs + 21×outputs + 3×kernels) × 0.0005` — so a payout costs the
  pool ~0.023 GRIN whether it is 25 or 2500 GRIN. Left unrecovered that cost scales with payout
  *count* and eats ~9% of fee income at a 25 GRIN floor (~23% at 10). 0.04 covers even a
  ~10-input sweep (~0.0275). Invariants: `0 ≤ withdrawal_fee < min_withdrawal`, enforced in
  `validateConfig` **and** re-checked in `PoolSettings.applyToConfig` (a per-field validator
  can't see the other value, and lowering the floor alone can strand a stored fee above it —
  that path falls back to 0 rather than making every at-minimum payout unpayable).
  - **Accounting (why it's charged on CONFIRM, not on request):** the miner is locked and
    debited the full gross `amount`; only `amount − fee_charged` goes on-chain. The fee is
    credited to `pool_fee` inside `_releaseLockAndDebit`, which runs only on a confirmed payout.
    Charging at request time would force every reversal path (Tor final failure, slatepack
    expiry, Nostr send failure, admin cancel) to un-charge it — miss one and the pool banks a
    fee for a payout that never happened *and* breaks the integrity invariant. On confirm,
    **zero reversal paths change**.
  - **Two columns, two different fees — do not conflate.** `withdrawals.fee` = the REAL on-chain
    network fee (backfilled by `recordTorFee` / `_slateFeeGrin`), read by reconciliation to
    explain the wallet-vs-ledger gap. `withdrawals.fee_charged` = the flat fee billed to the
    miner, frozen at request time so a later settings change can't rewrite historical terms.
    They are independent; the pool profits or loses the difference.
  - **Ledger shape:** the release writes **two** debit rows summing to the released amount —
    `reference_type='withdrawal'` (net, what the miner actually received) and
    `'withdrawal_fee'` (the fee) — plus a matching `'withdrawal_fee'` **credit** to `pool_fee`. Splitting
    keeps "paid to miners" honest: reconciliation's flow statement and the public payments page
    both read `debit/'withdrawal'` as money paid out, so logging the gross there would overstate
    every payout by the fee. `'withdrawal_fee'` is deliberately **not** counted as external money IN
    by `FLOW_CASES` — like `fee_cut`, it is an internal transfer of GRIN the pool already held.
    `reconciliation.js` `FEE_CASES.collected` counts `('pool_fee','withdrawal_fee')` together.
  - **Reporting:** every "GRIN sent to miners" figure in `hashrate-tracker.js` (hourly rollup,
    payments series, payout-size histogram, lifetime `paid_all`) reads
    `amount − COALESCE(fee_charged,0)`. Legacy rows carry `fee_charged = 0`, which is the
    historically *correct* value (they predate the fee), so the migration needs no backfill.
    `totals.fee_percent` stays the **block-reward** split only — mixing the flat fee in would make
    the advertised pool fee % depend on how often miners withdraw; the flat fees are reported
    separately as `totals.withdrawal_fees_all`.
  - **Open:** `payment-history.html` does not yet surface `withdrawal_fees_all` — the number is
    served but not rendered, so the public page currently understates total operator take.

---

## 8. Payments — Tor + Slatepack (one state machine, two transports)

Every Grin transaction is interactive (2-of-2). "Tor" and "Slatepack" are two **transports** for the
same slate round-trip, so there is **one** withdrawal state machine with a `method` dimension; only
"deliver the slate" branches. Balance locking, reversal, ledger, and audit are shared. *(Until
2026-09-26 this list also named "retry". A Tor payout is now tried once; see "One Tor attempt,
then an answer" below.)*

| Transport | Miner does | Works if miner offline? | Pool calls |
|---|---|---|---|
| **Tor** | nothing (listener auto-signs) | no | `init_send_tx` → post over Tor → `finalize_tx`, all inside ONE `grin-wallet send` CLI call, tried once per payout *(§8.1's step-by-step alternative was built 2026-09-25 and deleted 2026-09-26)* |
| **Slatepack** | copy-paste S1 → sign → paste S2 | yes | `init_send_tx` (lazy) → miner returns S2 → `finalize_tx` |

**Tor is primary, Slatepack is the fallback, and that is the whole set the pool ships.** A store-and-forward
relay rail (093 Transporter) was carried here as a reserved, forced-off placeholder until 2026-08-13 and
has been **removed**: pool payouts over the Transporter are blocked on wallet *relay-receive* support that
does not exist upstream, so the placeholder advertised a delivery date the pool could not set. Nothing was
wired — no scheduler branch, no `method='transporter'` — so removal is a deletion of the promise, not of a
feature. `public_html/js/payout-methods.js` makes rails self-registering, so re-adding one later costs a
file plus a `<script>` tag.

**There is no auto-payout.** *(Corrected 2026-09-25. This paragraph used to describe a 6 h
auto-payout scheduler that would fall back to a Slatepack claim. It was never built, and the
operator dropped it for good on 2026-09-24.)* Every payout is **miner-initiated** from the account
page, behind the ownership gate. An ungated automatic trigger was the abuse surface that gate
exists to close. The two inert settings keys, `payout.auto_payout` and `payout.payout_frequency`,
were deleted on 2026-09-25 (impl D10). A Tor payout that fails because the miner is offline is
refunded, and the page **offers** a Slatepack instead. It never turns into a Slatepack claim by
itself (see "One Tor attempt, then an answer" below).

**Slatepack security — IMPLEMENTED 2026-07 (differs from the original claim-token/payment-proof plan):**
the slate isn't inherently address-bound (the receiver supplies their output in S2), so two controls
apply: (1) an **IP ownership gate** (`lib/owner-proof.js`, anti-grief/anti-spam) — the requester must
present a mining source IP from the address's proof set (the last-2 window until 2026-09-22; up to 10 per kind since — §17), throttled 8/10min → 5min lockout; (2) **encryption
to the address** (anti-theft) — the S1 slatepack is age-encrypted to the miner's grin address
(`createSlatepackMessage(slate, [grinAddress])`), so a non-owner who clears the IP gate only gets an
undecryptable blob. `payment_proof_recipient_address` is left **`null`** — encryption, not payment proof,
is the anti-theft control actually shipped. Tor needs neither (listener is address-bound).

**Balance model** (`miner_accounts`, always in sync, each change logged):

| Event | balance | balance_locked |
|---|---|---|
| Create (CAS: only if balance ≥ amount+fee, else 409) | − (amount+fee) | + (amount+fee) |
| Confirm | — | − (amount+fee) |
| Fail proven by the wallet (Tor) / admin cancel | + (amount+fee) | − (amount+fee) |
| Held (Tor, outcome unknown) | — | stays locked |

Miner pays **no fee** on a failed/cancelled withdrawal (full reversal). **Max 1 pending withdrawal
per address** (429), and a Held payout counts as pending. Reference Slatepack pool: GaeaPool.

**One Tor attempt, then an answer** *(operator decisions 2026-09-26, FINAL unless reopened; as
built → impl §10.10)*. This replaced the 6/12/24/48 h retry ladder and its two uncounted
exceptions: the 1 h pool-wallet-short retry and the 15 min pool-tor-down retry.

- **A Tor payout is sent once.** It ends as one of three:
  - **Paid.**
  - **Failed**, with the balance returned at once. Only when the wallet proves nothing was sent.
  - **Held**, only when the pool cannot tell. The amount stays locked and it is never sent again.
- **Nothing re-sends a payout automatically, ever.** A refunded miner simply requests again, and
  that is a new payout, not a retry.
- **Why this is safe.** grin-wallet writes a `TxSent` entry to its tx log when it **locks** the
  outputs, and a transaction can be broadcast only after that lock. So the log decides it:
  - `confirmed` → it is on chain;
  - no match, or only a cancelled one → nothing was ever broadcast, and a refund is safe;
  - an unconfirmed `TxSent` → "locked, never sent" and "posted, not yet mined" look the same, so
    the payout is **Held**.

  A double payment needs either a second send, which does not exist, or a refund on top of a
  send that landed. The second needs the log to say "absent" about a broadcast tx, which the lock
  order rules out, **provided the amount matcher is right** and **provided the log is the history
  the send was made against**. The matcher accepts a tx only inside one of the payout's own send
  attempts, and it treats a tx two payouts could own as undecided (impl §10.10). A restored,
  seed-recovered or swapped wallet is not that history, so a refund waits for payouts to be
  unfrozen (restore, Migrate IN and a wallet switch all freeze), counts only reads taken after the
  last resume, and needs the log to still carry the row's history mark (review fix #1, 2026-09-27).
- **One send at a time from the pool wallet.** grin-wallet's `send` picks its coins at start but
  locks them only after the Tor round trip, and nothing stops a second selection of the same coins
  in between. So the Tor send holds the wallet send lock for its whole run, and a Slatepack or
  Goblin request made meanwhile is refused at once with nothing deducted. Two payouts can never
  spend the same inputs (review fix #2).
- **Held resolves itself** from the tx log. A confirmed tx → Paid, frozen or not. Absent on **two
  reads ≥ 10 min apart**, both while unfrozen and after the last resume → refunded. One read can
  race a wallet process that is still running. Its own never-finalized fallback lock is cancelled
  again, and its own send that got past the Tor round trip is re-broadcast hourly (the identical tx).
  Still held after 24 h → a critical admin alert.
- **The operator** can Re-check (the same rules), or force a refund. A forced refund needs
  step-up, the payout id typed back and an audit row. It is refused while the log shows a
  confirmed match, and while an unconfirmed match may have been posted: anything but a bare lock
  (`tx_slate_state` `Standard1`), because a posted tx can still be mined after a refund. Neither
  action sends anything.
- **Why a send failed.** After a slatepack fallback whose cancel succeeded, the pool probes the
  miner's onion once, fresh:
  - `false` → `wallet_offline`. It counts toward the pause.
  - `true` → `pool_send_path`. The pool's own send path is broken, as with payout #10. It raises
    a warning alert and does not count.
  - `null` → `wallet_unreachable`. It does not count.
- **Tor pause (anti-abuse).** 5 counted failures in 24 h pause Tor for that address for 24 h,
  from the 5th failure. The limits are constants, not settings. The pause is checked before the
  pre-flight probe, so a paused address cannot make the pool build Tor circuits either. Slatepack
  is not affected. The miner sees the end time in UTC, and before that an "N of 5" counter. The
  operator can clear a pause they judge was the pool's fault. Clearing re-codes the failures and
  deletes no history.
- **No reversal cooldown after a Tor failure.** A Tor refund now needs wallet proof, which is what
  the 30 min cooldown stood in for. The cooldown still follows a Slatepack expiry, a Goblin
  failure and an admin cancel.
- **Slatepack is OFFERED, never auto-created.** After any Tor "no" — the pre-flight refusal, a
  failed send, or the pause — the page shows one *Send as Slatepack instead* button. The button
  reuses the amount and the proof already typed, and goes through the one Slatepack create path
  with every gate. Its terms, including the response window, are stated before the click.
  - It is hidden for `pool_busy`: the pool wallet could not cover a Slatepack either.
  - It is hidden while any payout is pending, Held included.

**Rejected: create the Slatepack automatically on "unreachable" and hold the miner to it.** The
operator proposed this and rejected it the same day, for four reasons:

1. "Unreachable" is often a wallet that is still starting up. Its onion can take a minute or more
   to answer. Today that costs nothing and a new request works at once. An automatic Slatepack
   would lock the balance for the whole window (30 min by default, with no miner cancel), plus the
   cooldown if it expires.
2. Many Tor users cannot do the manual `receive` step. For them it would only be a 30 min freeze.
3. It turns a free refusal into a pool-wallet transaction that locks pool coins. Anyone who clicks
   with an offline wallet would trigger one, and enough of them starve other miners' payouts.
4. It would not have saved payout #10, where the check passed and the send failed.

Do not reopen it without a new reason.

**"Paid" is not "mined."** A row reaches `confirmed` when the send succeeds. It gets its kernel,
and with it the public "<method> · mined" badge (P-05 Method column) and the explorer link, only once the pool wallet's tx
log shows the tx **confirmed**. A kernel in the tx log proves nothing about the chain: it is
written at lock time and rewritten at finalize. A paid row not seen mined after 1 h raises the
rolling `payout_unmined` admin alert. It is a warning when the tx is sent but not mined, and
**critical** when the wallet cancelled the tx or has no record of it, because then the miner was
debited and not paid. An unmined row gets one CLI repost of the identical stored tx per hour, up
to 24. A repost cannot pay twice, because the chain accepts the same inputs at most once. Nothing
is refunded or re-sent automatically. This watchdog is the **opposite direction** of
reconciliation's `auditWalletSends`, which flags a confirmed wallet send with no pool row.

**Tor pre-flight probe** *(corrected 2026-09-23: this section used to say "no TCP port-probe before
send", which has been false since the pre-flight gate was built on 2026-07-19)*. Before it locks any
funds, a Tor withdrawal probes the miner's wallet. The pool derives the v3 onion from the grin
address and POSTs `check_version` to that onion's foreign API over a fresh Tor circuit. The answer
is **tri-state**: `true` means a grin-wallet answered. `false` means the pool's own tor works and the
wallet did not answer, so the payout is refused with a 409 and nothing is locked. `null` means the
pool could not look (its own tor is down or silent), so the gate **fails open** and grin-wallet
decides at send time. A timeout with no reply from the local proxy is `null`, never `false`.
The 409 carries `suggest: 'slatepack'`, which the page turns into the Slatepack offer. A refusal
here is not counted toward the Tor pause. Mechanics and reason codes → impl §10.5.

A probe **answering ✓ does not mean the send will work.** The probe runs in the pool's Node process
through the system tor. The send is a separate `grin-wallet` process with its own Tor. Mainnet
payout #10 passed the probe and failed because that process never started: the binary was not on
the unit's `PATH` (impl §10.10).

### 8.1 Step-by-step Tor send (F5) — DESIGN 2026-09-25, BUILT the same day, DELETED 2026-09-26 (never ran on a VPS)

> **Status (2026-09-26): deleted.** The operator chose one CLI attempt per payout (§8, "One Tor
> attempt, then an answer"). The step-by-step sender was removed first, so that only one Tor
> sender had to change. With it went `payout.tor_send_mode`, its two timeout keys,
> `pool_tor_unavailable` and the `payout_tor_stepwise` alert.
>
> Kept: `_dropStepwiseSlate`, for a row it may have touched before the deletion; the `tor_step` /
> `tor_final_slate` columns, INERT now; and every Owner v3 method, because the Slatepack and
> Goblin rails call them. As-built record of what existed → impl §10.8 F5.
>
> **§8.1.1 is still the reference** for what `grin-wallet send` does. Its exit-0 bug is fixed on
> the CLI rail, and the fallback's cancel is now outcome B's proof of absence. The §8.1.2 safety
> facts (only the pool's own `post_tx` reaches the chain; the pool wallet's Foreign `finalize_tx`
> posts, so it must stay localhost-only) also still hold. §§8.1.2–8.1.7 are otherwise design
> history. The text below is left as written, including its present-tense "today".

The Tor rail today runs `grin-wallet send -d <grin1…> -a <net>` as one opaque CLI step
(`lib/wallet-tor.js` `sendToTorAddress`, SIGKILLed at `wallet_send_timeout_ms`). This section
designs the replacement. The pool drives the same payment in steps through the Owner API. It
writes the slate id to its own DB before any coin is locked, and before any byte leaves the box.
Recovery then becomes an exact lookup. It ships behind `tor_send_mode` (default `cli`).

Every grin-wallet claim here was read in the source of **v5.5.0** (tag `v5.5.0`, commit `ffcdf78`)
and of **v5.4.1**. v5.4.1 was the toolkit pin until 2026-09-25. That day a working-tree change,
not yet committed, moved the shared `GWI_DEFAULT_TAG` to v5.5.0, while Fidelius keeps its own
v5.4.1 pin. So a pool may run either version. Each claim holds for both unless it is marked.
Paths are relative to the grin-wallet repo.

#### 8.1.1 What `grin-wallet send` actually does — and a bug it causes today

`controller/src/command.rs` `send`, both versions:

1. *(v5.5.0 only)* `retrieve_summary_info` with a node refresh.
2. `init_send_tx` with `payment_proof_recipient_address` = the destination. This is the default:
   `src/cmd/wallet_args.rs` `parse_send_args` sets it unless `--no_payment_proof` is passed.
   Nothing is locked yet.
3. `try_slatepack_sync_workflow` (`api/src/owner.rs`) starts its **own** Tor client.
   - v5.4.1 launches a tor child process on `socks_proxy_addr` (`impls/src/adapters/http.rs`
     `launch_tor`).
   - v5.5.0 runs in-process Arti when `[tor] use_integrated = true`. That is the default for a
     newly written toml (`config/src/types.rs` `TorConfig::default`). Otherwise it launches the
     same child process.
   - It then POSTs `check_version`, then `receive_tx`.
4. **Only if S2 came back:** `tx_lock_outputs` → `finalize_tx` → `post_tx` → prints
   `Tx sent successfully`.
5. **If the Tor delivery fails, it falls back to a slatepack file.** v5.4.1 gets `Ok(None)`;
   v5.5.0 gets `Err(e)`. Both call `output_slatepack(lock = true)`. That **locks the outputs**,
   writes `<wallet>/slatepack/<slate-uuid>.S1.slatepack`, prints the slatepack and returns `Ok`.
   The binary then **exits 0** with `Command 'send' completed successfully`
   (`src/cmd/wallet.rs` `wallet_command`).

What step 5 means for the pool as it runs today. This design does not fix it; the Part 6 prompt
raises it as open question 1. *(Fixed 2026-09-25 on the CLI rail: only `Tx sent successfully`
counts as sent, and the fallback slate is cancelled before the retry (impl §10.8). The watchdog
bullet below still describes a row that was marked paid **before** that fix. A `Standard1` class
in the watchdog was recommended and is **not** built.)*

- **A miner the pool could not reach is marked PAID.** `execWalletCommand` resolves on exit 0, so
  `sendWithdrawal` calls `markConfirmed`. The miner is debited and receives nothing. The pool
  wallet keeps a locked S1 that was never finalized, so those coins stay locked until someone
  cancels it. That lost capacity can itself cause the F3 `NotEnoughFunds` shortfall.
  - Only failures that exit non-zero reach the retry ladder: the 120 s SIGKILL,
    `NotEnoughFunds`, a node error.
  - A fast Tor failure takes the exit-0 path. "Onion descriptor not found" is the usual one.
- **The F2 watchdog labels such a row `unmined`, a warning.** The row is a TxSent that is not
  confirmed. The CLI repost it tries finds no stored tx (`does not have transaction data. Not
  reposting.`, still exit 0), so the row never resolves. The label also understates the problem:
  the miner was **not** paid.
  - On v5.5.0 the tx log can tell the two apart. `tx_slate_state` reads `"Standard1"` for a tx
    that was only locked and `"Standard3"` once it is finalized (`libwallet/src/internal/selection.rs`
    `lock_tx_context`; `libwallet/src/api_impl/types.rs` `update_tx_slate_state`).
- **Coins are chosen at step 2 but locked only at step 4.** Between the two sits a Tor round trip
  of up to 20 s per request in v5.4.1 (reqwest client) or 60 s in v5.5.0.
  - `lock_output` does not check whether a coin is already locked (`lock_tx_context`), and there
    is no lock across processes.
  - So the pool's own `owner_api` process can select the same coins meanwhile (Slatepack / Goblin
    create). Two transactions then spend one input, and one of them can never mine.

#### 8.1.2 The stepwise sequence

Every wallet call goes through the one Owner API v3 (`lib/wallet.js`) with **named** params. The
parameter names are identical in both versions (the `owner_rpc.rs` doctests): `init_send_tx`
`{token,args}`, `tx_lock_outputs` / `finalize_tx` `{token,slate}`, `post_tx` `{token,slate,fluff}`,
`cancel_tx` `{token,tx_id,tx_slate_id}`. Tor I/O runs in Node through `lib/socks5.js` and the
system tor daemon (`tor_socks_port`). That is the daemon the pre-flight probe already uses. No
second grin-wallet process is started.

| # | Durable record, written *before* the step | Step | What it does in the wallet / on the wire |
|---|---|---|---|
| 0 | claim `tor_checking → tor_sending` (guarded), event note `stepwise: claim`, `tor_step='claimed'` | — | — |
| 1 | — | `init_send_tx` (net nanogrin, `payment_proof_recipient_address` = the miner's grin1, `ttl_blocks: null`, `late_lock: null`) | Selects coins and saves the private context. It adds **no lock and no tx-log entry** (`libwallet/src/api_impl/owner.rs` `init_send_tx`; `selection.rs` `build_send_tx`). Returns V4 S1. |
| 2 | `slate_id`, `fee` (from S1), `tor_step='initiated'`, event `slate: <uuid> created`, in one guarded write | — | — |
| 3 | — | `tx_lock_outputs` | Adds the TxSent entry and locks the inputs, in one batch commit, so either both happen or neither (`lock_tx_context`). Then `tor_step='locked'`. |
| 4 | freeze check; `tor_step='delivering'` before the first `receive_tx` byte | deliver over Tor | Connects with a fresh isolation tag, then POSTs `check_version`. It requires `foreign_api_version ≥ 2` and `"V4"` in `supported_slate_versions` (the CLI's own check, `check_other_version`). Then it POSTs `receive_tx` with params `[S1, null, null]`. `result.Ok` is S2. |
| 5 | `tor_step='finalizing'` | `finalize_tx` S2 | Verifies the receiver's proof signature (`internal/tx.rs` `verify_slate_payment_proof`) and stores the complete tx (`update_stored_tx`). It **never posts**: `owner.rs` `finalize_tx` calls `foreign_finalize(…, false)`. |
| 6 | freeze check; `tor_step='posting'` + `tor_final_slate` = S3, in one write | — | — |
| 7 | — | `post_tx` S3, `fluff: true` | On OK: `_creditConfirm('tor_sending', 'stepwise: posted')`, and `tor_final_slate` is cleared. From here the F2 watchdog owns the row. The kernel and proof backfills match it by its exact slate id. |

Steps 1–3 run under an in-process send lock (`WalletAPI.withSendLock`). The Slatepack and Goblin
create paths take the same lock around their own init → lock. Without it, the step-2 race from
§8.1.1 would still exist inside one process.

`receive_tx` goes out **positional**, `[slate, null, null]`, because that call hits the
*miner's* Foreign API, which can be any grin-wallet version. The CLI sends exactly this in both
versions (`impls/src/adapters/http.rs` / `tor.rs` `send_tx`). The named-params rule covers our
own Owner v3 calls. The third parameter must stay `null`: a return address would make the
receiver call *our* Foreign `finalize_tx` itself (`api/src/foreign.rs` `receive_tx`).

**The safety line: nothing reaches the chain except through the pool's own `post_tx`.** Four
facts establish it:

- **The miner cannot finish the transaction without us.** `receive_tx` only adds the receiver's
  output and partial signature (`libwallet/src/api_impl/foreign.rs` `receive_tx`). Completing the
  kernel needs our partial signature. Its secret nonce and key live only in our wallet's private
  context, and completion happens in our `finalize_tx` (`complete_tx`).
- **Our finalize never posts.** See step 5.
- **The pool wallet's Foreign `finalize_tx` DOES post** (`api/src/foreign_rpc.rs` →
  `Foreign::finalize_tx(…, true)`), but miners cannot reach it.
  - It is mounted on the owner port by `owner_api_include_foreign`, and that port binds to a
    hard-coded `127.0.0.1` (`config/src/types.rs` `owner_api_listen_addr`).
  - **Invariant: it stays localhost-only.** Never publish the pool wallet's listener over an
    onion or nginx.
- **grin-wallet never posts on its own.** Its only automatic transaction action is the TTL
  auto-cancel described below.

Two rules follow from this.

- **Every state before step 6 can be cancelled safely.** `cancel_tx` unlocks the inputs and
  rewrites TxSent as TxSentCancelled. A later finalize of that slate fails in `update_stored_tx`,
  which requires a TxSent entry (`internal/tx.rs`).
- **From step 6 on, the transaction is committed.** The only action allowed is to post it again.
  Never cancel it and never rebuild it: a rebuilt slate may pick different inputs, and then both
  transactions can mine.

**`ttl_blocks` stays `null`, as the CLI leaves it.** On every refresh the wallet cancels any
unconfirmed tx whose `ttl_cutoff_height` has passed. The source is `owner.rs`
`update_wallet_state`, "Step 5: Cancel any transactions with an expired TTL", run over
`retrieve_txs(outstanding_only)`. With a TTL set, it would cancel a payout that was posted but not
yet mined. The F2 watchdog would then report a false "cancelled — the miner was NOT paid".

#### 8.1.3 Failure matrix — one recovery per state

"Cancel" below always means `cancel_tx(S)`. It needs a reachable node: otherwise it returns
`Can't contact running Grin node. Not Cancelling.` (`owner.rs` `cancel_tx`). A cancel that fails
leaves the row in `tor_sending` at the same step, and the sweep tries the cancel again. A row
**never** moves to `retry_scheduled` while its slate is still alive.

| Fails at (`tor_step`) | The pool wallet holds | The miner may hold | Recovery |
|---|---|---|---|
| init (`claimed`) | nothing (an orphaned private context at most) | nothing | `NotEnoughFunds` → `scheduleRetry('pool_wallet_short')` (F3, uncounted). Anything else → counted retry. |
| the step-2 write loses its guard (row moved meanwhile) | private context only | nothing | Stop. Nothing is locked, so nothing needs undoing. |
| lock fails or times out (`initiated`) | maybe a locked S1 | nothing | Cancel. `TransactionDoesntExist` means it was never locked, which is fine. Then a counted retry. |
| before any `receive_tx` byte: **our** tor is down (`tor_unavailable`) | locked S1 | nothing | Cancel, then an **uncounted** retry, reason `pool_tor_unavailable`, in 15 min. After 24 of those it takes the ladder like any failure (F3's cap pattern). A broken pool tor says nothing about the miner. |
| before any `receive_tx` byte: onion unreachable or timed out, not a wallet, wrong slate version | locked S1 | nothing | Cancel, then a **counted** retry. This is the miner-offline case the ladder exists for. |
| `receive_tx` written; the reply is missing, garbled, too large or late (`delivering`) | locked S1 | maybe a TxReceived + S2 | Cancel, then a counted retry. Sending the same S1 again cannot bring back a lost S2: the receiver refuses a second receive of that slate id (`TransactionAlreadyReceived`, `foreign.rs` `receive_tx`). A new receive would also create a different output. The money is safe because the miner cannot finalize. What the miner may see is an incoming tx that never confirms (Part 6, open question 3). |
| `receive_tx` answered with a JSON-RPC error | locked S1 | nothing | Cancel, then a counted retry. |
| finalize fails or times out (`finalizing`) | locked S1, maybe a complete stored tx | S2 | Never broadcast, because the pool posts only after step 6. Cancel, then a counted retry. A proof-signature failure is the miner wallet's fault (it signed with a different address). |
| the freeze is on at the step-4 or step-6 check | locked S1, or a complete tx not yet broadcast | nothing, or S2 | Cancel, then put the row back to `tor_checking`. That is not a rung; it goes out after resume. |
| `post_tx` throws or times out (`posting`) | complete tx, maybe already in the mempool | S2 | **Committed.** Keep `tor_sending`/`posting`. The sweep posts `tor_final_slate` again via `post_tx`, at most every 5 min and never while frozen. A post that returns OK, or the tx log showing it confirmed, settles the row. A rejected duplicate proves nothing either way: the same inputs mean it can land only once. Never cancel it. After 24 failed re-posts it stays parked and raises a critical alert. |
| the process dies at any step | as above | as above | The sweep (`reclaimStaleTorSending`, stepwise branch) reads `tor_step` and applies the matching row above. `claimed` → back to `tor_checking`. A cancellable step → cancel → back to `tor_checking`: a crash is the pool's fault, not the miner's, so it costs no rung. `posting` → post again. |
| the tx log contradicts the record | — | — | Confirmed in the log → confirm the row, since chain evidence wins. Cancelled or absent while `posting` → park, **critical**, and never settle it automatically in either direction. |

#### 8.1.4 Where the state lives

**No new statuses.** The row stays `tor_sending` for the whole attempt. Every place that lists
statuses therefore already handles it:

- `PENDING_SQL`
- AlertMonitor's `inFlight`
- reconciliation's two lists
- the admin cancel route's 409
- the three lists in `index.js`
- the three lists in `payments.html` (since the 2026-10 payouts split there are two: the
  `STATUS` labels, still in `payments.html`, and `PAYOUT_ACTIVE_STATUSES` in
  `admin-panel/payouts-common.js`, which replaced `ACTIVE` and `inflightStatuses` — implementation §10.14)
- the account page's "sending over Tor now…"

Two new columns carry the progress: `withdrawals.tor_step` and `tor_final_slate`, both `TEXT NULL`.

**How a row is recognised as a stepwise attempt.** Its newest `to_status='tor_sending'` event note
starts with `stepwise:`. The CLI claim writes no note and is not touched. `tor_step` is read only
under that marker, so a stale `tor_step` left by an earlier stepwise attempt can never misroute a
CLI attempt. Each slate the row creates is journaled as `slate: <uuid> …`, and `slate_id` holds
the latest.

**Invariant.** A stepwise row leaves `tor_sending` only when its slate is confirmed, provably
cancelled, or was never locked. So `tor_checking` and `retry_scheduled` never hold a live slate,
and the admin cancel route, which accepts those two statuses, can never refund one.

#### 8.1.5 Re-attempt guard

Before a stepwise re-attempt creates a new slate:

1. **Every journaled slate, plus `slate_id`, is looked up exactly.**
   - Confirmed TxSent → confirm the row, as today.
   - Unconfirmed TxSent → this breaks the invariant, so `_deferSend` (uncounted) and log loudly.
   - Cancelled or absent → that slate is dead; move on.
2. **If the row ever had a CLI attempt** (a `tor_sending` event without the marker), the existing
   `_priorSendLanded` also runs, amount branch included, with today's three outcomes.

`markFailed`'s last-rung guard is unchanged. On a stepwise row it sees the latest slate cancelled,
reads that as `absent`, and so has proof that a refund is safe.

#### 8.1.6 The switch

`payout.tor_send_mode` is `cli` (the default) or `stepwise`. The operator sets it as a select in
admin → Payout, and it takes effect when the backend restarts.

- `stepwise` needs the Owner API wallet. Without it, the scheduler logs an error at start and runs
  `cli`.
- **Changing the mode means a restart.**
  - Rows in `tor_sending` are resolved by the sweep according to how *their own* attempt was
    made, not by the current mode.
  - Rows in `tor_checking` / `retry_scheduled` hold no live slate (the invariant), so their next
    attempt uses the new mode. §8.1.5 covers both kinds of history.
- Switching back to `cli` is always safe.

#### 8.1.7 What stays the same, and version notes

**Unchanged:**

- **Lock-first.** The balance lock at create is untouched. The wallet lock now also comes before
  anything leaves the box; the CLI locks after.
- One pending payout per address.
- Guarded claims.
- **Never refund without wallet proof.** A cancel that reads back as `TxSentCancelled` is that
  proof.
- Deferrals stay uncounted.
- The last-rung guard.
- **The freeze.** It is checked at claim, before delivery and before post, and the sweep's
  re-post skips while it is on.
- F2 and F3.
- **The payment proof.** The init argument is the CLI's, the receiver signs the same message,
  and finalize is the same libwallet function the CLI calls. So `retrieve_payment_proof` returns
  the same proof for a stepwise row.

**Version notes:**

- The receiver protocol is identical in v5.4.1 and v5.5.0: `check_version` → `receive_tx
  [slate,null,null]`, V4 only.
- v5.5.0 adds `InitTxArgs.refresh_outputs_from_node` (default `true`) and keeps every field our
  client sends.
- v5.5.0's `tx_slate_state` is not needed here, because `tor_step` is the pool's own record. It
  may be logged as a second signal.
- The design works on either version, so it neither needs nor blocks the pin move to v5.5.0.
- §8.1.1's exit-0 bug exists under both versions, so moving the pin does not fix it.

**Timeouts:**

- SOCKS connect: 30 s.
- `check_version`: 30 s, absolute.
- `receive_tx`: 60 s, absolute. That matches v5.5.0's CLI `request_timeout` default.
- Response cap: 1 MiB.
- One retry on a fresh circuit, for connect / `check_version` only. After the first `receive_tx`
  byte, a retry would be a second receive.
- `init_send_tx` may refresh from the node, so it needs a per-call timeout of 60 s (`lib/wallet.js`
  uses 10 s today).
- A worst-case attempt takes about 4 min, well under the sweep's 600 s floor. An in-process
  live-attempt set also keeps the sweep off a row whose attempt is still running.

**Tests:** an in-process fake SOCKS5 + Foreign API on `127.0.0.1:0` (the pattern already in
`scripts/test-payout-rails.js`) and a fake Owner wallet. One test per row of the failure matrix,
each shown to fail with its guard removed.

---

## 9. White-label / branding / SEO / incentives

Operator customisation flows from the admin panel into the public pages **client-side** (nginx serves
static pages; Express only answers `/api/*`):

```
admin (settings.html) ─POST /api/admin/settings/<section>─▶ pool_settings (SQLite)
public page ─GET /api/public/branding─▶ buildPublicConfig() ─▶ /js/branding.js applies
   title/meta/OG/Twitter/canonical/JSON-LD · theme (CSS vars + custom CSS + font) ·
   analytics · maintenance overlay · banners · [data-brand] content
```

- **`branding.js`** is loaded by every public page and is **defensive** — any fetch/field failure
  leaves the page's hardcoded defaults intact. It bridges the two theme systems (public
  `body.<theme>-theme` classes + admin `theme.js` CSS variables).
- **Config sections** in `pool-settings.js` defaults: `branding` (logo/dark-logo, theme,
  custom_theme JSON, font, hero/CTA), `seo` (title_template, per-page SEO, structured data),
  `analytics` (GA4 / Plausible / Umami / Matomo + custom head/body HTML + cookie consent),
  `pages` (operator-authored about/terms/privacy/faq/impressum), `notices` (maintenance mode +
  announcement banners).
- **Dynamic SEO/PWA:** `robots.txt`, `sitemap.xml`, `manifest.json` generated by Express and served
  via exact-match nginx `location =` proxies. Canonical origin = `seo.site_url` else request host.
- **Theme builder:** colour picker per CSS variable → hidden `custom_theme` JSON; 13 selectable
  themes via shared `css/themes.css` + `js/public-theme.js`; export/import.
- **Miner-config generator** (`/connect`) builds copy-paste lolMiner/GMiner/SRBMiner commands from
  `/api/public/branding`.
- **Uploaded assets** served at `/custom/<file>` from a config-driven `assets_dir`.

### Incentives (prize pool, bonuses, lottery)
All under the **Incentives** admin tab, off until `incentives_enabled`. Register-free preserved
(grin_address is identity). Funded by a reserved **`prize_pool`** pseudo-address (fee-cut diversion +
miner `donateN` worker tags + manual top-ups / published Slatepack donation address).

- **Join bonus** — one-time, paid only after an address's first confirmed withdrawal (anti-Sybil).
- **Block-finder jackpot** — flat amount at block maturity; clawed back on orphan. Sybil-proof.
- **Loyalty streak** — capped multiplier for consecutive days; funded from `prize_pool`.
- **Lottery** — weekly + special events; pot A share-weighted, pot B equal-chance;
  **verifiable** (winner derived from the node tip block hash captured at draw time).

Public pages: `donate.html` (channels + live prize-pool size), `fortune-board.html` (winner history
+ draw seed for audit).

> Known register-free trade-off: pot B + per-address bonuses are partly Sybil-farmable; share-weighting
> + min-shares bar + the Sybil-*proof* features (jackpot, streak, fee-cut) carry the fairness load.
> Optional free accounts for true one-person-one-entry is a deferred phase-2 item.

---

## 10. UI / UX

Static HTML + vanilla JS in `public_html/`:
`index, login, miners-stats, payment-history, pool-info, system-health, account-settings,
admin-dashboard, connect, donate, fortune-board, page` + the IPOLLO testnet guide.
A second admin tree lives in `back-end-pool/admin-panel/` (index/users/miners/payments/health/settings).

**Public pages:** home (miners online, pool/network hashrate C32, last block, fee, luck %, price,
24h chart, 5–10s refresh); `/blocks`; `/payments` (aggregated/anonymized); `/miners` (top-50 by 24h
hashrate, truncated addresses); `/account/:addr`; `/faq`. **Admin:** dashboard, users, miners,
withdrawals, payment-stats (reconciliation + anomalies), health, settings.

**Standards:** per-page SEO (title/description/OG/canonical + JSON-LD); mobile responsive
(tables stack, ≥44px touch targets); GA4/analytics via the branding system; central `escHtml` on every
interpolation sink; worker-name regex enforced at the stratum layer.

---

## 11. Network ports

| Service | Mainnet | Testnet | Access |
|---|---|---|---|
| Public stratum (miners) | 3333 | 13333 | Public |
| Per-region stratum listeners (Model C) | 3391, 3392 … | 13391, 13392 … | **WireGuard interface only** (`region_listen_host`; loopback until set) |
| WireGuard (gateway tunnels) | udp 51820 (`wg-grinpool`, 10.66.66.0/24) | udp 51821 (`wg-grinpool-tn`, 10.66.67.0/24) | Public UDP on the central box; peers are explicit |
| Node built-in stratum (proxy upstream) | 127.0.0.1:3416 | 127.0.0.1:13416 | localhost only |
| Central API / Pool HTTP API | 8080 | 8090 | Public web (nginx). No ingestion surface — see §6 |
| Web dashboard | 443 | 443 | Public |
| Node API (Owner/Foreign) | 3413 | 13413 | localhost |
| Wallet Foreign / Owner | 3415 / 3420 | 13415 / 13420 | localhost |
| P2P | 3414 | 13414 | Public |

> A regional gateway box exposes the public stratum port `3333`/`13333`; it holds no
> node, wallet, DB or keys, and reaches the central box over the tunnel alone. Because both a
> pool server and a gateway want `:3333`, `pool_mode_conflict_check` keeps them on separate boxes.
> **Since 2026-09-23 a gateway may also expose `:443`** — only when the operator turns on its
> `6) Latency probe` (§13.13.5): a separate HAProxy instance answering `GET /ping` with an empty
> 204 and 404 to everything else. `:80` is then opened for certbot's standalone challenge but is
> bound only for the seconds of an issue/renewal. The hub's own `/ping` rides its existing `:443`.
>
> The single-box installer was migrated off the legacy `3417/3002` to `3333/8080` in 2026-06
> (bash + backend in sync — see `config.js`). The **node upstream** was NOT moved with them:
> the `3334` this doc once planned was never implemented, because Script 01 leaves the node's
> `stratum_server_addr` at grin's default, so the pool must dial `3416`/`13416` out of the box.
> Three sites carry that number and must stay agreed — `pool_ensure_defaults`
> (`07_grin_mining_public_pool.sh`), `node_stratum_port` (`back-end-pool/lib/config.js`), and
> `grin_sync_pool_stratum` (`lib/grin_node_secrets.sh`), which re-patches the toml after a node
> rebuild. It is operator-overridable via `node_stratum_port` in the pool config. The **solo**
> product (`07_grin_mining_solo.sh`) dials the same `3416`/`13416`.

---

## 12. Follow-ups (not implemented)

> Tracked as deferred decisions D2–D9 in
> [`script07_implementation.md`](script07_implementation.md) → "Deferred decisions & open items".
> Do not re-implement without a product call. (The 2026-06-08 security hardening — trust proxy,
> bcrypt 12, lockout, refresh revocation, jwt fail-loud, escHtml, confirm_depth 1440 — is **done**;
> see that doc's status table and security audit §B.)


- Move money columns from `REAL` GRIN to **integer nanoGRIN** (engine-independent; do it in SQLite,
  carries to Postgres later).
- i18n / multi-language content; fiat (USD/EUR/BTC) price display.
- Unify the public `body.<theme>-theme` system onto the `theme.js` CSS-variable system.
- Admin live-preview iframe + WCAG contrast check in the theme builder.
- Optional free miner accounts for true one-person-one-entry lottery.

---

## 13. Admin-panel gateway pairing — IMPLEMENTED 2026-07-13 (same day as design; NOT VPS-tested — see §13.6b)

> Collapses the 4-hop WireGuard pairing ping-pong (gateway pubkey → SSH to hub CLI →
> pairing string → back to gateway → *then* declare the region again in admin → Regions)
> into **one admin-panel form** that does the WG peer add and the `pool_locations` upsert
> atomically. Kills the dual-registry drift that `pool_wg_list` currently warns about.
> **Implementation branch: `add-ons`** — operator decision 2026-07-13: pool work moves to
> `add-ons` (it contains the `publicpool` tip; WG hub↔gateway path is E2E-verified, so the
> separate testing branch is retired for new work — fast-forward `publicpool` or leave frozen).

### 13.1 Target UX (after)

```
GATEWAY BOX                          HUB ADMIN PANEL (browser)
1. Toolkit → Gateway → 1) Install
   → prints WG public key   ────────→ 2. Regions & Gateways → ➕ New region
                                         fill label/country/stratum URL
                                         + paste gateway pubkey → Save
                            ←──────────  panel shows GRINGW1|… (copy button)
3. 2) Configure → paste GRINGW1
4. 3) Tunnel up → 4) Start           5. Status chip goes green (handshake age)
```

Two human hops instead of four; no SSH session on the hub; region exists in exactly one
place. The gateway-side flow ([`07_lib_gateway.sh`](../../scripts/lib/07_lib_gateway.sh))
is **unchanged** — it already consumes the `GRINGW1` string.

### 13.2 Component 1 — `grin-gateway-ctl` root helper (single WG mutation path)

One root-owned executable becomes the **only** code that mutates `/etc/wireguard/wg-grinpool*.conf`
and `region_ports`; both the CLI `W` menu and the panel backend call it. Logic moves out of
`pool_wg_add_peer` / `pool_wg_list` / `pool_wg_remove_peer` (currently
`07_grin_mining_public_pool.sh` ~1927–2140) into the helper; those menu functions become thin
callers that pretty-print its JSON.

- **Deployed to:** `/usr/local/bin/grin-gateway-ctl` (root:root `0755`), written from a heredoc
  by a new sourced lib **`scripts/lib/07_lib_gwctl.sh`** (`pool_gwctl_install()`), called from
  `pool_wg_setup_server` and on every hub setup run (idempotent regen, like other units).
- **Language:** bash + embedded `node` for JSON (the hub always has Node; the *gateway* box
  doesn't, but the helper never runs there).
- **Per-network:** every subcommand takes `--net mainnet|testnet` and derives
  `WG_IFACE` / tunnel `/24` / `ListenPort` / `REGION_PORT_BASE` / `$POOL_CONF` exactly as
  `07_grin_mining_public_pool.sh:1853-1866` does today (single source: the helper).

| Subcommand | Does | stdout (always JSON) |
|---|---|---|
| `add-peer --net N --region R --pubkey K` | validate → dup-guard → assign next free `/32` + region port (existing region KEEPS its port) → append `[Peer]` → `wg syncconf` → write `region_ports` + `region_listen_host` into pool.json | `{ok, existing:false, region, peer_ip, region_port, hub_pubkey, hub_endpoint, hub_tunnel_ip, pairing:"GRINGW1\|…"}` |
| same, pubkey already a peer | **no write** (preserves the 2026-07-05 cryptokey-routing lesson) | same shape with `existing:true` |
| `remove-peer --net N --region R` | delete `[Peer]` block + `region_ports[R]` → `wg syncconf` | `{ok, removed:R}` |
| `list --net N` | re-derive pairing strings from wg conf + pool.json | `{ok, gateways:[{region, peer_ip, region_port, pairing}]}` |
| `status --net N` | `wg show <iface> dump` → per-region handshake age + rx/tx bytes | `{ok, gateways:[{region, handshake_age, rx_bytes, tx_bytes}]}` |

**Validation inside the helper (never trusts the caller, even root):**

| Input | Rule |
|---|---|
| `--net` | literally `mainnet` or `testnet` |
| `--region` | `^[a-z0-9-]{2,12}$` |
| `--pubkey` | `^[A-Za-z0-9+/]{43}=$` (wg key wire format) |
| AllowedIPs | **not an input** — helper computes next free `/32`; `0.0.0.0/0` is unrepresentable |

Errors → non-zero exit + `{ok:false, error:"…"}` on stdout so `execFile` callers get one parse path.

**Privilege note:** `grin-pool-manager` currently runs `User=root`
(`07_grin_mining_public_pool.sh:470`) — historical convenience, not a requirement. §13.9
de-roots it as part of this work; the backend calls the helper via
`sudo grin-gateway-ctl …` under a one-line scoped sudoers entry. Design the backend call as a
single `gwctl()` wrapper so the sudo prefix lives in exactly one place.

### 13.3 Component 2 — backend (`back-end-pool/index.js`)

All handlers call the helper via `execFile('/usr/local/bin/grin-gateway-ctl', [...], {timeout: 10000})`
— argv array, never a shell string. One shared `gwctl(args)` promise wrapper.

1. **Extend `POST /api/admin/locations`** (`secureAdmin`, exists at ~3068) with an optional
   `wg_pubkey` body field. When present and non-empty: after the `pool_locations` upsert,
   call `add-peer`; on success include `pairing` + `peer_ip` + `region_port` (and `existing`)
   in the JSON response; on helper failure return `502` **with the location still saved** and
   a `wg_error` field (metadata save must not be hostage to wg state). Audit-log action
   `gateway_pair` with `{region, pubkey, peer_ip, region_port, existing}`.
2. **New `GET /api/admin/gateways/:region/pairing`** (`secureAdmin`) → helper `list`, filter
   by region → `{pairing}`. Powers a "Show pairing string" button for lost strings (replaces
   SSH `W → 3`).
3. **Extend `DELETE /api/admin/locations/:id`** (`freshAdmin`, exists at ~3101): optional
   `?remove_peer=1` also calls `remove-peer` for that region. Peer removal is destructive →
   stays behind `freshAdmin` (recent re-auth), audit action `gateway_unpair`.
4. **Status:** no new endpoint — `GET /api/admin/health/gateways` (~2977) already merges share
   recency + `readWgHandshakes()` + active TCP probe. Optionally later: enrich with rx/tx from
   helper `status` (the existing `readWgHandshakes()` stays as the zero-dependency fallback).

**Listener activation without a stratum blip (hot-bind).** Today a new region requires a
`grin-pool-manager` restart so `stratum-server.js` binds the new tunnel-IP listener
(`lib/stratum-server.js:126-128` reads `region_ports` only at start). The panel backend *is*
that same process, so restarting it from a request handler is self-defeating. Design:

- Add `bindRegionListener(region, port)` to `StratumServer` — same accept/stamp logic as the
  boot-time loop, callable at runtime; update in-memory `config.region_ports[region]` after the
  helper succeeds, then call it. No restart, zero miner disruption.
- The **CLI** path (`W → 2`, now helper-backed) keeps its existing
  `systemctl restart grin-pool-manager` since it runs outside the process; on next boot the
  hot-bound listener is rebuilt from pool.json anyway (helper already persisted it).
- `remove-peer` v1 does **not** hot-unbind (rare op; listener on a removed region just goes
  idle until the next natural restart — document in UI copy).

### 13.4 Component 3 — panel page (`admin-panel/regions.html`)

Page renames to **"Regions & Gateways"**. Changes to the existing form/table (482-line page,
form fields at ~180–210):

- New form field: **Gateway WireGuard public key** *(optional — leave empty for a
  metadata-only region entry: a label with no tunnel behind it)*, with inline format hint
  (44 chars, ends `=`).
- After save-with-pubkey: result card showing the `GRINGW1|…` string in a monospace box with a
  📋 copy button + the four-step "what to do on the gateway box now" mini-guide. Warn banner
  when `existing:true` ("key already paired — existing tunnel IP/port kept").
- Per-row **tunnel chip** fed by the already-polled `/api/admin/health/gateways`:
  `🔒 handshake 12s` (green <180s / yellow <600s / red otherwise / grey "no peer") next to the
  existing stratum-probe status; plus a "Show pairing string" row action (endpoint #2).
- Delete flow gains a checkbox "also remove the WireGuard peer (unpair the gateway box)" →
  `?remove_peer=1`.
- **Field guide** (collapsible at top, currently "STEP 1 of 4") rewritten to the new 2-hop
  flow: 1 install on gateway box → 2 this form → 3 paste string there → 4 watch chip go green.

### 13.5 CLI (`W` menu) after the refactor

`W → 1` setup server: unchanged + installs the helper. `W → 2/3/R`: thin wrappers —
prompt as today, call the helper, pretty-print (colored) from its JSON. Kept as the offline
fallback and for headless operators; because both paths share the helper, drift is impossible.
The "region wired but not declared in admin" warning in `pool_wg_list` stays (still reachable
via CLI-only pairing) but should become rare.

### 13.6 Security summary

- **No key material moves.** Only public keys and internal addressing cross the panel; both
  private keys stay in their boxes' root-only files. Trust model identical to the CLI flow.
- **Blast radius of a compromised admin session** = add/remove a stratum-forwarder peer with a
  helper-chosen `/32` — strictly less than the payout/config power an admin session already has.
  Tunnel-side listeners are only the per-region stratum ports (Central API stays on localhost).
- Helper self-validates all inputs (§13.2), `execFile` argv only, `freshAdmin` on unpair,
  audit log on pair/unpair, dup-pubkey guard preserved verbatim.

### 13.6b Implementation deltas (2026-07-13 — what building it changed vs the plan)

- **grinsecret group covers BOTH node secrets, not just foreign.** The §13.9 audit missed
  that `lib/grin-node.js` reads the node's `.api_secret` (Owner, `get_status`) *and*
  `.foreign_api_secret` directly by path (the pool runs as root). `pool_deroot` +
  `grin_sync_pool_stratum` set `root:grinsecret 640`
  on both (the secret self-heal re-applies it after a node rebuild).
- **The pool wallet LISTENER is de-rooted too.** The backend spawns `grin-wallet send`
  (payouts) as `grinpool`; a root-run tmux listener would leave root-owned lmdb/tx-log
  files that EACCES the send. `pw_write_launchers` now drops the listener to `grinpool`
  (su + `HOME=<wallet dir>` + pre-launch chown sweep, mirroring the node launch contract)
  whenever the user exists.
- **Helper gained a region-replace flow.** `add-peer` on an existing region with a NEW
  pubkey swaps the key in place — the region keeps its tunnel IP *and* port (the §13.10d
  gateway-box-replacement story, previously only implicit). Response carries `replaced:true`.
- **Panel delete "checkbox" is a second `confirm()`** (native dialogs can't host one);
  a third confirm guards unpairing a gateway that handshook <180 s ago.
- **`wg_endpoint_host` (§13.10b) is a plain pool.json key** set via CLI menu `W → 5`
  (no helper subcommand — the helper reads it when composing endpoints).
- **§13.10c backup:** the legacy plain `pool_backup` + cron wrapper were replaced outright
  (wrapper/cron file names kept so cleanup keeps matching); product names `pubpool` /
  `pubpooltestnet`; C) cron menu option 1 delegates to the same `pbk_schedule`.
- **Local verification done:** `bash -n` + `node --check` on all touched files; the
  generated `grin-gateway-ctl` exercised end-to-end with stubbed `wg`/paths (fresh add,
  dup-key no-write, region replace, validation rejects, remove, list/status, DNS
  endpoint); `_gns_toml_repatch` unit-tested (quote-normalised no-op fix baked in);
  `_pbk_make_tar` include/exclude verified. **The §13.8 VPS plan still stands** — real
  wg syncconf, the sudo path from the de-rooted service, hot-bind E2E, and the live-box
  migration order (testnet hub → payout round → mainnet) are untested.

### 13.7 Files changed (branch `add-ons`)

| File | Change |
|---|---|
| `scripts/lib/07_lib_gwctl.sh` | **new** — writes `/usr/local/bin/grin-gateway-ctl` (heredoc), `pool_gwctl_install()` |
| `scripts/07_grin_mining_public_pool.sh` | source new lib; install helper in `pool_wg_setup_server`; refactor `pool_wg_add_peer`/`pool_wg_list`/`pool_wg_remove_peer` into helper callers; `pool_deroot()` (§13.9): grinpool user, chown sweep, hardened unit, sudoers |
| `web/07_mining_pool_public/back-end-pool/index.js` | `gwctl()` wrapper; extend locations POST/DELETE; pairing GET |
| `web/07_mining_pool_public/back-end-pool/lib/stratum-server.js` | `bindRegionListener()` hot-bind |
| `web/07_mining_pool_public/back-end-pool/admin-panel/regions.html` | pubkey field, pairing card, tunnel chip, unpair checkbox, guide rewrite |
| `scripts/lib/07_lib_gateway.sh` | none (consumes `GRINGW1` unchanged) |
| `scripts/lib/07_lib_pool_backup.sh` | **new** (§13.10c) — hub backup on shared gbe_*/gbp_* engine |
| `scripts/lib/grin_node_secrets.sh` | add `grin_sync_pool_stratum` consumer (§13.10a) |
| hub menu / `07_lib_pool_wallet.sh` | "Replace pool wallet" entry reusing existing `pw_*` steps (§13.10e); `wg_endpoint_host` option (§13.10b) |

### 13.8 Test plan

1. `bash -n` all touched scripts; `node --check` index.js / stratum-server.js.
2. Helper unit pass on a VPS: `add-peer` (fresh + dup + second region), `list`, `status`,
   `remove-peer`; verify `wg show` peers and pool.json after each.
3. Panel E2E on testnet: create region with pubkey → copy string → gateway `2) Configure` →
   tunnel up → chip green → `nc` a raw stratum login through the gateway → share stamped with
   region (proves hot-bind worked **without** restarting `grin-pool-manager`).
4. Regression: CLI `W → 2` add for a *second* gateway while the panel-added one stays alive
   (syncconf must not drop the live tunnel); dup-pubkey re-add from the panel shows the
   `existing:true` banner and changes nothing.

### 13.9 De-rooting `grin-pool-manager` (part of this work)

**Why root is unacceptable here:** this one process parses untrusted input from the public
internet on TWO surfaces — the HTTP API behind nginx AND the raw stratum TCP socket (:3333,
arbitrary miners, JSON protocol parsing) — on top of a large npm dependency tree. Any RCE or
supply-chain hit is currently an instant **full root** compromise: hub WG private key (tunnel
impersonation + pivot into every gateway), node `.api_secret`s, Let's Encrypt keys, audit-log
tamper, persistence. Honest caveat: de-rooting does NOT protect the hot wallet — the backend
must be able to spend (payouts) by design, so a compromised backend can still drain it at any
privilege level (see `script07_security_audit.md` §Residual risks). De-rooting protects the
*box*, the *keys*, and the *other products* on it.

**Audit result (2026-07-13):** the running service has exactly ONE root dependency —
`readWgHandshakes()` (`index.js:50-70`: reads root-only `/etc/wireguard/*.conf` + runs
`wg show`). No `systemctl` calls, no other privileged ops; ports are unprivileged;
everything else is file-ownership convenience.

Plan (new `pool_deroot()` in the hub setup, runs on install + idempotently on upgrade):

1. **Service user:** `useradd -r -s /usr/sbin/nologin grinpool` (per-box, both nets share it).
2. **Ownership sweep:** `chown -R grinpool:grinpool` on `$POOL_APP_DIR` (app + pool.db + logs),
   `$POOL_CONF` (admin panel writes config), and the pool **wallet dir** (grin-wallet spawn +
   `.wallet_pass` + tor send dirs). Node secrets: `grinpool` needs read on the node's
   `.foreign_api_secret` — group-read via a `grinsecret` group rather than world-read.
3. **Unit changes:** `User=grinpool`, plus hardening now that it's meaningful:
   `ProtectSystem=strict` + `ReadWritePaths=` (app dir, wallet dir, conf dir), `ProtectHome=yes`,
   `PrivateTmp=yes`, `RestrictSUIDSGID=yes`. **Do NOT set `NoNewPrivileges=yes`** — it blocks
   sudo, which the helper path needs (revisit only if the helper ever moves to a socket-
   activated root service).
4. **Sudoers:** one file `/etc/sudoers.d/grin-pool-gwctl`:
   `grinpool ALL=(root) NOPASSWD: /usr/local/bin/grin-gateway-ctl` (helper is root-owned 0755,
   root-writable only — sudoers on a non-root-writable absolute path).
5. **Code swap:** `readWgHandshakes()` is replaced by the `gwctl('status')` wrapper
   (`sudo grin-gateway-ctl status --net …`); keep the existing silent-`catch` fallback so a
   box without the helper (old install, gateway-only role) degrades to share-recency status
   exactly as today.
6. **Migration on live boxes:** re-running hub setup applies user+chown+unit+sudoers, then
   restarts. Test order: testnet hub first; verify stratum accepts shares, admin login works,
   a payout round completes (wallet spawn as `grinpool`), THEN mainnet.

Blast-radius after: compromised backend = hot-wallet funds (unavoidable by design) + peer
add/remove via the validated helper. It can no longer read the WG/hub private keys, node
owner secrets, or write outside its own dirs.

### 13.10 Operational scenarios & disaster recovery (added 2026-07-13)

Five real-life scenarios, scoped honestly: two needed **new code**, three are **runbooks**
(documentation + small menu affordances). All belong to this work package.
*(Status 2026-08-22: both new-code items — (a) and (b) — are BUILT. The per-scenario
"New code" lines below are kept as the original scoping, each annotated with what shipped.)*

**a) Grin node rebuild (new api/foreign secrets) — mostly already automatic.**
`07_lib_pool_wallet.sh:577` already installs the shared secret self-heal
(`grin_node_secrets.sh` timer, every 5 min): a rebuilt node's new `.foreign_api_secret` is
re-applied to the pool wallet's `node_api_secret_path` without operator action
(`grin_sync_wallets` sweeps `/opt/grin/**/grin-wallet.toml`). **The uncovered half:** a
rebuild wipes the node's own `grin-server.toml`, losing the pool's stratum wiring
(`enable_stratum_server`, `stratum_server_addr` :3416/:13416, `wallet_listener_url` → :3420).
→ **New code — ✅ BUILT.** `grin_sync_pool_stratum` (`lib/grin_node_secrets.sh:576`) is in the
`grin_secrets_sync_all` chain and ships exactly as scoped: guarded on the pool conf existing,
re-applies `enable_stratum_server`, `stratum_server_addr` (from the conf's `node_stratum_port`,
defaulting to `3416`/`13416`) and `wallet_listener_url` → `:3420`/`:13420`, and does NOT restart
the node — it prints "RESTART the <net> node to take effect". It also re-applies the de-rooted
`root:grinsecret 640` mode a rebuild would reset to `600 root:root`. Runbook line: after any node
rebuild, `grin-secret-sync` once + restart node + check admin health page.

**b) Provider/IP change of the HUB — make endpoints DNS-based (small helper feature).**
Today `add-peer` bakes the ipify-resolved raw IP into every pairing string; an IP change
strands every gateway (each needs `wg_hub_endpoint` edited by hand). → **New code (cheap) — ✅ BUILT** (`pool_wg_endpoint_host`, menu `W → 5`; read by
`07_lib_gwctl.sh`):
optional `wg_endpoint_host` in pool.json (set once in helper/panel, e.g. `hub.grinium.net`);
when set, pairing strings carry `host:port` instead of the raw IP. WireGuard resolves the
name at `wg-quick up` — so a provider IP change becomes: update DNS A record → each gateway
`systemctl restart wg-quick@wg-grinpool` (or the toolkit's 3) Bring up tunnel). Existing
IP-paired gateways: one-field edit in `2) Configure` (manual path already supports it).
*(Superseded in part 2026-09-23, §13.13.3: a gateway now runs a **re-resolve timer**, so with a
DNS-name endpoint it follows a hub IP change within ~2–3 min of the DNS change with no restart
on the gateway box. The raw-IP case is unchanged: `2) Configure` the new endpoint, then `3)`.)*
Gateway IP changes need nothing on the hub (gateway dials out) — only the miner-facing DNS
(`stratum_url` in pool_locations) moves.

**c) Hub disaster recovery — NEW `07_lib_pool_backup.sh` on the shared engine.**
The pool hub is the ONLY money-holding product without backup today (solo has
`07_solo_backup.sh`, drop has `059_lib_backup.sh`, both on the shared `grin_backup_engine.sh`
gbe_*/gbp_* + offsite push). Same model (personal key, `grin_pubpool_backup_DDMMYYYY`,
daily cron, scp push). Backup set — everything a fresh `07` install can't regenerate:
`pool.db` (balances/shares/audit — snapshot via SQLite `.backup` or two-phase tar like 059,
never a live copy of a WAL db), `$POOL_CONF` (incl. `region_ports`), wallet dir (seed +
`.wallet_pass` + tor keys), WG identity (`$WG_DIR_CONF/server_*.key` + `/etc/wireguard/wg-grinpool*.conf`
— restoring these means **gateways reconnect with zero re-pairing**), nginx vhost + cert
note. Restore runbook: fresh box → Script 01 node (or restore alongside) → `07` hub install
→ restore backup → `grin-secret-sync` → re-point DNS (trivial if (b) is DNS-based) →
gateways reconnect on their PersistentKeepalive with no operator action on any gateway box.
*(⚠ Corrected 2026-09-23 — that last clause held only when the restored hub keeps its IP.
WireGuard resolves a hostname `Endpoint` once, at `wg-quick up`, and PersistentKeepalive keeps
sending to the address it already has. Three cases, now stated the same way in
`07_lib_pool_backup.sh`: **same IP** (rebuild in place) → gateways reconnect on their own;
**new IP + DNS-name endpoint + re-resolve timer** → they follow within ~2–3 min of the DNS
change, no action on the gateway box; **new IP + raw-IP endpoint** → on each gateway,
`2) Configure` the new endpoint, then `3)`. A planned move to a new box is now its own guided
flow, Migrate OUT / Migrate IN — §13.13.4.)*

**d) Gateway disaster recovery — runbook only, by design (< 5 min).**
A gateway's total state = `grin_gateway.json` + one WG keypair; everything else is
regenerated. Two paths: (1) *no backup needed*: fresh box → Gateway `1) Install` (new
keypair) → panel: unpair old key / pair new pubkey (region **keeps** its tunnel IP + port by
the existing replace-guard) → paste new GRINGW1 → up; miners' DNS unchanged if the new box
takes over the IP, else one A-record flip. (2) *with the (c) engine, optional*: a tiny
`grin_gateway_backup` tar of `/opt/grin/gateway` + `/etc/wireguard/wg-grinpool.conf` +
`grin_gateway.json` restores the SAME identity — no hub-side action at all. Document both;
(1) is the primary story because it needs nothing prepared in advance.

**e) Hot-wallet switch (compromise / corruption) — runbook + menu option.**
Safe by architecture: miner balances/owed amounts live in **pool.db**, not the wallet, so
swapping wallets never loses accounting. Procedure (new hub menu entry "Replace pool
wallet", also documented for manual use): 1 pause payouts (admin toggle) → 2 move old wallet
dir aside → 3 `grin-wallet init` fresh (new seed, recorded offline) → 4 re-run the existing
wallet setup path (toml patch, `.wallet_pass`, ECDH unlock, node `wallet_listener_url`
re-patch + node restart — all existing `pw_*` code) → 5 sweep old wallet balance → new
wallet from a separate box/dir (old seed still valid unless truly compromised; if
compromised, sweep FIRST, fastest wins) → 6 resume payouts. Coinbase maturity note: rewards
mined to the old wallet in the last 1440 blocks must mature before the sweep completes —
keep the old dir until balance is zero.

### 13.11 Out of scope (deferred)

**Level 2 token enrollment** — panel mints a one-time token; gateway box POSTs its pubkey to a
public `POST /api/gateway/enroll` and receives the pairing payload (zero human key-carrying).
Bolts onto this design (same helper, same response shape); revisit only if third-party
operators run gateways at scale.

### 13.12 Panel-side multi-region bootstrap + onboarding fixes — IMPLEMENTED 2026-08-22 (NOT VPS-tested)

§13.1 promised "pair a gateway without an SSH session on the hub". That was **false for
every pool that had never gone multi-region**: `add-peer` requires `/etc/wireguard/wg-grinpool*.conf`,
which only `pool_wg_setup_server` (menu `W → 1`) created. Worse, the panel's region save
upserted `pool_locations` **before** calling the helper — so the first attempt left a saved
region card *and* a 502 naming an SSH menu the how-to never mentioned. A flow-trace of both
routes (bash + panel) found seven more onboarding defects around it; all are fixed here.

**a) `grin-gateway-ctl init-server` — the hub tunnel becomes a helper subcommand.**
Package (install, retrying once behind `apt-get update`), keypair, `/etc/wireguard` conf,
firewall UDP rule, `wg-quick up` + enable, `region_listen_host` in pool.json. Idempotent by
construction: an existing conf is **kept** (regenerating rotates the hub key and strands every
paired gateway) and a live interface is **synced, never bounced**. Also re-derives a missing
`server_public.key` from the private key — otherwise an interrupted first run makes every
later pairing string carry an empty hub key. Emits the usual single JSON object.

**b) `pool_wg_setup_server` is now a thin caller over (a).** It was a second implementation of
the same steps; the tunnel net, listen port and conf layout had to be kept in sync by hand
across two files. Same posture as `add-peer`/`remove-peer`/`list` since §13.5.

**c) Panel: `GET`/`POST /api/admin/gateways/server`.** GET is the page's pre-flight (`ready`
true/false, never an error — "no tunnel" is the normal state of a single-box pool); POST runs
init-server behind `freshAdmin` step-up (raising a tunnel is at least as sensitive as pairing a
peer, which is already step-up gated) with a 180s exec timeout, audits `gateway_server_init`,
and mirrors `region_listen_host` into the live config. `regions.html` renders either an
**Enable multi-region** banner or the hub's coordinates.

**d) The half-write is gone.** `POST /api/admin/locations` now pre-flights with a read-only
`list` **before** the upsert when a `wg_pubkey` is present, returning **409 `wg_server_missing`**
and writing nothing. The client checks that flag *before* the existing `wg_error` branch, which
would otherwise report "region saved" about a request that saved nothing.

**e) CLI `add-peer` parity with `remove-peer`.** Remove already `DELETE`s the `pool_locations`
row; add only printed "remember to declare it", which is how a region ends up wired but invisible
on the connect grid. Add now inserts the card with `is_active = 0` — visible in admin, not on the
public grid, because there is no stratum hostname to publish yet.

**f) The CLI restart is now a choice, not a surprise.** Panel pairing hot-binds; the CLI runs
outside the process and can only restart `grin-pool-manager`, which drops every miner on **every**
region. It now says so and asks, and names the panel as the no-restart path.

**g) Gateway box: firewall + honest next-step.** `gw_install` never opened the public stratum
port (the hub opens its own wg port), so a box with active ufw finished pairing green and refused
every miner. New `gw_open_firewall` runs from Install and Configure; `gw_status` reports the ufw
rule beside the listener. Install's tail said "Next: 2) Configure" — the one thing the operator
must *not* do, since the pairing string does not exist yet; it now stops and points at the hub.

**h) DNS is a step.** The A-record (pointing at the **gateway** box, not the hub) was a
parenthetical; it gates the Port-check column, so its absence read as a broken gateway. It is now
its own numbered step in the panel how-to and is printed by both `gw_configure` and CLI add-peer.

**i) `gw_configure` silent no-op.** The region-port prompt composes `hub_endpoint` from two
answers and dropped the port when the hub tunnel IP was still blank, with no message. It now says
what was not saved and why.

**Second pass (same day) — six defects found reviewing (a)–(i):**

**j) A readable conf is not a running tunnel.** `list` reported only that `$WG_CONF` exists, so
the panel's readiness light went green on a hub whose interface was down — the state in which
*every* gateway is dark. `list` now carries `interface_up` (`wg show`), the GET forwards it, and
the banner has a third state: **set up, but the tunnel is DOWN**, whose button is the same
idempotent `init-server` (keeps the keypair, so nothing needs re-pairing).

**k) `Auth.fetch` resolves `null` on failure — it never throws.** `loadServerState`'s `try/catch`
was therefore dead code, and a failed/rate-limited request fell through to `!d.ready` and nagged a
healthy pool to enable a tunnel it already runs. It now moves state only on `d.success === true`;
`_mrReady` is tri-state (`null` = never answered, and `null` is not evidence of anything).

**l) `_mrReady` was written and never read.** It now short-circuits a save that carries a
`wg_pubkey` while the hub is known-not-ready — otherwise `adminFetch` prompts for the step-up
password on the way to a guaranteed 409.

**m) `synced:false` was invisible in the panel.** `add-peer` reports when `wg syncconf` did not
load the new peer into the running interface; the CLI has always warned, the route dropped the
field and reported plain success. The symptom then appears on the *gateway* box and reads as a
pairing fault. Now returned as `sync_warning` and shown on the pairing card.

**n) The CLI's `pool_locations` insert could create a root-owned `pool.db`.** `node:sqlite` opens
create-if-missing, so (e) would have created the database — and, in WAL mode, `pool.db-wal`/`-shm` —
owned by root, after which the de-rooted `grinpool` service cannot open its own database. Guarded
on the file already existing, and the WAL sidecars are chowned back unconditionally.

**o) `apt-get` did not wait for the dpkg lock.** A fresh VPS is usually mid-`unattended-upgrades`;
without `-o DPkg::Lock::Timeout=60` both install attempts fail instantly and the operator is told
wireguard-tools "could not be installed" by a box that was merely busy for 20 seconds.

Also corrected in the same pass: the new-region tail ("two things left", DNS, region card) was
printing on the **box-replacement** path too, where all of it is already done; add-peer's
prerequisite error named only the SSH menu; and the CLI's "publish it" hint omitted that the
region card's **Active** checkbox is what actually publishes it.

**p) THE BLOCKER: `ProtectSystem=strict` made every panel-side WireGuard write fail.** Found
answering "is this ready to test?", before any of it ran. The hardened unit (§13.9) builds a
**mount namespace**, and a namespace is inherited by every child — *including one that becomes
root through setuid `sudo`*. Gaining root does not get you out of it. `/etc/wireguard` was not in
`ReadWritePaths`, so `sudo grin-gateway-ctl add-peer` ran as root and still could not append a
`[Peer]`. This was never an `init-server` bug: it broke **`add-peer` and `remove-peer` too**,
i.e. the whole §13.1 promise of "pair a gateway without an SSH session", for every de-rooted box.
`list` and `status` are reads, so the pre-flight, the readiness banner and the health column all
kept working — the page looked healthy right up to the moment you saved. `NoNewPrivileges` was
already deliberately absent with a comment about this very sudo path; the mount namespace simply
was not the part that got considered.

Fixed by opening exactly one path and moving the rest off the request:
- `ReadWritePaths` gains `-/etc/wireguard`. DAC still applies inside the namespace, so `grinpool`
  cannot write those root-owned files itself — only the scoped helper can.
- New `pool_ensure_wg_prereqs()` installs `wireguard-tools` **and creates `/etc/wireguard`** at
  pool-install time. Both must happen before the unit starts: `apt` can never run inside the
  namespace (`/usr`, `/var` read-only), and `ReadWritePaths` is bound at service **start**, so a
  directory created later is not writable in the already-running service's namespace.
- The update path does not rewrite the unit, so `pool_deploy_code` now detects a pre-§13.12p unit
  (`ProtectSystem=strict` without `/etc/wireguard`) and says which operations will fail.
- Steps that remain outside the namespace are reported instead of swallowed: `systemctl enable`
  (writes `/etc/systemd/system`) returns `boot_enabled`, and `ufw allow` already returned
  `ufw-failed`. Both surface as persistent **caveats** on the page — the tunnel is up, but a
  reboot loses it / the UDP port is still shut, and neither has a local symptom.
- Error strings now name the namespace and the fix, rather than saying "install it manually".

`/etc/systemd/system` and `/etc/ufw` stay closed, deliberately: those two steps are worth one SSH
command, and widening the unit for them would trade the whole point of de-rooting for convenience.

Accepted risk, not fixed: `init-server` may still install a package inside an HTTP request when
run on a box where the installer's `pool_ensure_wg_prereqs` did not succeed, so an `execFile`
timeout can interrupt `apt`. The 180s budget makes that unlikely, and the common path no longer
touches apt at all.

Unchanged and deliberately so: the shared-helper architecture, the GRINGW1 string, the dup-key
and same-region guards, and the §13.11 token enrollment (still deferred — these fixes reduce the
manual hops but do not remove the two hand-carried payloads).

**q) `1) Install` was not safe to re-run — and (p) makes re-running it the documented fix.**
Prescribing "re-run Install once to pick up the new unit" turned a first-run-only assumption into
a data-loss bug. `pool_install`'s rsync was `rsync -a --delete "$POOL_APP_SRC/" "$POOL_APP_DIR/"`
with **no excludes**, so on an already-installed box it mirrored the checkout and deleted every
runtime artefact the app owns: `pool.db` (every miner's balance), `.wallet_pass`, `custom_assets`,
`uploads`, `node_modules`. On a first install `POOL_APP_DIR` is empty and each exclude is a no-op,
which is exactly why the gap survived — the bug is invisible until the step is run a second time.
`pool_install` now carries the same exclude list as `pool_deploy_code`.

The same audit found `uploads/` (CMS media from the admin editor) missing from `pool_deploy_code`'s
excludes, so **every code deploy silently pruned it** — independent of (p), and older. The comment
on the nginx `/uploads/` block asserted the opposite, and its reasoning is the trap worth naming:
living *outside* `public_html` protects a dir from the **docroot** rsync in `pool_deploy_web`, and
not at all from the **backend** rsync, which `--delete`s `POOL_APP_DIR` itself. Both comments are
corrected, and the rule is now stated where the next author will be adding a runtime dir: every new
dir the app writes under `POOL_APP_DIR` needs an exclude in **both** rsyncs.

**r) A failed "Enable multi-region" was indistinguishable from an ignored click (found 2026-09-19,
first live report).** The operator clicked, confirmed, and minutes later saw the same banner with the
same pre-flight reason (`wg-grinpool.conf missing`). Three independent gaps, all fixed:
- **Every `flash()` in the admin panel rendered nothing.** `pool.css` gave `.error-msg` /
  `.success-msg` `display: none`, and each page's `flash()` reveals with `el.style.display = ''` —
  which only removes the element's inline `display:none` and then defers back to the stylesheet's.
  So the red "Could not enable multi-region: …" was never painted, on this page or on miners,
  payments, pages, posts, ads or users (all use the pattern; all have carried it since the
  2026-06 merge). The `display:none` is gone from the two rules — every element that uses them
  already hides itself inline, which is where the initial state belongs.
- **The failure did not stay on screen, and was not where the operator was looking.** `flash()`
  targets `#r-msg` on the *Add or edit a region* toolbar, three cards below the banner, and
  clears in 5 s; `#mr-reason` describes the STATE and is untouched by a failed attempt. The
  banner now has a persistent `#mr-error` under the button — cleared on retry, hidden when the
  tunnel reads as up — carrying the helper's message plus the journal / `W → 1` fallback. The
  fallback is **omitted when the 403 carries `step_up`** (the browser-side refusal below): nothing
  reached the pool then, so "check the journal" would be false and SSH the wrong next step.
- **The box kept no record.** The POST route audits `gateway_server_init` only on success and its
  catch did not log, so a failed enable left nothing in the journal either. It now
  `console.error`s. `gwctl()` also names a **timeout** explicitly — a helper killed at 180 s
  prints no JSON, and execFile's bare `Command failed: sudo -n …` read as an instant failure.

A fourth gap turned up on the same path while reading the evidence: the `/api/admin/` nginx block
had `proxy_read_timeout 30s` under a route whose helper is budgeted **180 s** (the apt path). On
that path nginx would 504 the browser while init-server kept running to success — "Enable failed"
about a tunnel that came up seconds later. Raised to 200 s (re-run **4) Setup nginx** to apply).

On the reporting operator's box the evidence cleared every server-side candidate: the sudo journal
showed the page's `list`/`status` reads and **no `init-server` call at all**, the helper carried the
subcommand, sudoers/`ReadWritePaths`/`wireguard-tools` were all in place, and an in-namespace
reproduction (`nsenter -m` → `runuser -u grinpool` → `sudo -n … init-server`) succeeded first time.
So the POST was refused **before** the handler. The nginx access log settled which gate: one
`POST /api/admin/gateways/server … 403` with a **53-byte** body — exactly
`{"error":"Session expired","challenge_required":true}`, the `requireFreshAuth` step-up challenge
(the 2FA refusal is 131 bytes) — and **no `POST /api/admin/reauth` after it**. The password prompt
`adminFetch` opens on that challenge was closed without a password: the operator's own account was
"clicked Enable and OK", i.e. OK on the *second* dialog, the prompt, with nothing typed — which
`reauth()` treats as cancel. `adminFetch` then handed back the original 403, the caller threw
`"Session expired"` (false: the session was fine) into the dead `flash()`, and the button reset.

Fixed at the two places the story went wrong, on top of (r)'s visibility fixes:
- `stepup.js` `reauth()` now resolves `{ outcome: 'ok' | 'cancelled' | 'failed', reason }`, and
  `adminFetch` answers a cancelled or failed step-up with a **synthetic 403** whose body says what
  happened ("Not done — this action needs your admin password and the authorization dialog was
  cancelled…"; `step_up: 'cancelled'|'failed'`, the failure `reason` inlined). Every caller
  prints `body.error` verbatim and none matched the literal text, so this corrects payments,
  users, miners and settings in the same edit.
- The Enable confirm() now says a password box may open next, and how to complete it.

Verified locally by driving `adminFetch` through a stub `fetch` + empty `prompt`: one request, no
reauth call, no retry, 403 with the new body. Note the operator's own reproduction
(`nsenter … init-server`) had already raised the tunnel, so the panel path was not re-clicked.

**Second live finding, same day, after deploying the above:** the operator clicked Enable, got
the new red "Not done — … the prompt was closed without one" — and **no password prompt had
appeared at all**. That branch is reachable only when `window.prompt()` returns null/empty, so
the browser (Firefox 156) had refused to open it. The pattern is exactly what browsers throttle as
"successive dialogs": the step-up prompt comes ~200 ms after the action's own `confirm()` closes,
from an async continuation (the 403 has to arrive first), i.e. without user activation. Which
rule fired is not knowable from the page, and does not matter: a page cannot tell a suppressed
native dialog from a Cancel, so **`window.prompt()` is the wrong tool for the step-up** — and it
had also been echoing the admin password in cleartext. `stepup.js` now opens an **in-page
dialog** (built lazily from the panel's own `.modal-overlay`/`.modal` rules in `pool.css`, which
every admin page loads; masked `type=password`, `autocomplete=current-password`; Enter submits,
Escape/Cancel/backdrop cancel, focus returns to the button). Null now means the operator's own
decision, and the message says "the authorization dialog was cancelled". Flow: a wrong password or
code re-opens the dialog with the server's reason (a typo must not cost the whole action); the
second factor is a separate code-only step, asked only after the pool accepted the password
(`/api/admin/reauth` verifies before it answers `totp_code_required`); a lockout or budget
refusal ends the loop and the 403 carries the retry time; concurrent protected requests share one
dialog. Verified with a stub DOM through nine scenarios (three cancel paths, empty submit, wrong→
right password, 2FA with a wrong code, lockout, two-at-once, fresh session). NOT VPS-tested.

**s) The gateway was asked for a number only the hub knows (found 2026-09-19, first live
pairing).** The Regions card for `yyz` read `stratum+tcp://yyz.grinium.com:3333 · ✗ :3333
unreachable · 🔒 1m ago · ● Active` — a healthy tunnel and a dead port — while `ss` on the gateway
showed haproxy on **:13333**. Every region is advertised on the pool's single public port
(`regions.html` appends `STRATUM_PORT` to the host, and the Port check dials the same URL), so the
gateway has exactly one right answer for "Public stratum port", and it cannot derive it: the value
lives in the hub's `pool.json`. Yet `gw_configure` *asked*, and its prompt printed the saved value
in brackets, so the 13333 typed once (the pool's testnet number) came back on every later run
looking like a default — the operator's reading, reasonably, was "the setup says 13333". Two
"command not found" lines from the heredoc trap (memory `reference_bash_unquoted_heredoc_backticks`)
printed in the same screen, which did not help the prompt's credibility.

Fixed at the source: `grin-gateway-ctl` reads `stratum_port` from `pool.json` (per-network default
when absent) and appends it as the pairing string's **8th field** in both emitters (`add-peer` and
`list`, so the panel's Save, its 🔑 re-print and the SSH menu all agree); the response JSON also
carries `public_stratum_port`. `gw_apply_pairing_string` accepts 7 or 8 fields (a string from an
older hub still works), validates the port, writes `public_stratum_port` and says so when it
changed the saved value; it also strips CRs, since the last field is now a number a Windows
clipboard would turn into `3333\r`. The prompt gained the missing sentence — the POOL's port, where
to read it (admin → Regions shows `Port :NNNN`), and that a current pairing string fills it in.
Compatibility edge: an 8-field string on a pre-fix gateway is **rejected** (bash `read` folds the
extra field into `region_port`, which fails the digit check) — pull both boxes together; documented
in the implementation doc's format row. Same day, `5) Status` gained an **On reboot** line: the
forwarder and the tunnel are enabled by two different menu steps (`1)` and `3)`), each `|| true`,
and a box missing either reboots into `:3333 listening` with nothing behind it — which the Port
check reads as ✓. Verified with stubs: hub emitter (default / explicit / missing key, both
emitters), gateway parser (7 fields, 8 fields, CR, bogus port, out-of-range, 9 fields, unchanged
port), Status in all four enabled/disabled combinations. NOT VPS-tested.

**t) Status cried wolf about ufw (found 2026-09-20, first live gateway).** With the port fixed by
(s), the gateway's `5) Status` read `:3333 listening · ufw is ACTIVE but :3333 is not allowed —
miners will be refused`, and re-running `1) Install` and `2) Configure` (both call
`gw_open_firewall`) changed nothing. The actual unreachability was a wrong A record; once that was
corrected miners connected — *while Status still showed the warning*, which is only possible if ufw
was never active on that box. The cause: (g)'s three ufw tests in `07_lib_gateway.sh` and
`07_lib_gwctl.sh` were the bare `ufw status | grep -q active`, and a disabled ufw answers
`Status: inactive` — a string that contains `active`. So an inactive ufw was "active": Configure
printed `ufw: opened 3333/tcp` (a rule on an inactive ufw does nothing), Status found no rule table
to match and warned forever, and on the hub `init-server` reported `firewall: ufw` for a UDP port it
had not opened. Every other script in the repo already anchored the test (`"Status: active"`); the
three Script-07 sites now do too. The unmanaged branch also stopped being a blank: Status now says
`host firewall: none active — not what blocks :3333`, checks `iptables -S INPUT` for a raw
DROP/REJECT (the Oracle-image trap that `ufw status` never shows) and points at the provider's
network firewall, and firewalld gained the `--query-port` readout ufw always had. Configure's order
is unchanged and deliberate: the port is opened at the END, after the pairing string may have
changed it — opening "as soon as the port is entered" would open the stale number. Stub-tested
(inactive / active-no-rule / active-rule / `on eth0` rule / raw-iptables REJECT).

### 13.13 Hub move (Migrate OUT / IN) + connect-page latency — BUILT 2026-09-23 (NOT VPS-tested; adversarial review done 2026-09-23, 7 fixes)

Built in seven parts on one day, to move the mainnet hub from New York (racknd) to **OVH
Gravelines, France**, with gateways in New York, Los Angeles, Hong Kong and Toronto. Two tracks:
**the move** (seeds, gateway re-resolve, Migrate OUT, Migrate IN) and **the connect page**
(estimate, probe endpoints, browser measurement). The as-built detail (files, keys, manifest
schema, runbook) is impl §8.7; this section keeps the *why*. **Nothing here has run on a VPS.** The
adversarial review (money path first) ran the same day: six confirmed defects fixed, twelve
plausible ones reported, and one of those (P1, the VACUUM race) fixed the next day — the security audit's Status roll-up ("Part 9 review") has the table,
and §13.13.6 below what is still open.

#### 13.13.1 The evidence behind the placement

A 2026-09-23 survey of the big Grin pools (DNS → geolocation) found three of four HK-centred —
their "US" and "EU" hostnames alias one HK box — and the two real non-Asia cores in **Germany**.
Nobody runs a real central-US server. Globalping from the same probes to Gravelines and Strasbourg:
the two differ by ~1–15 ms everywhere, but **HK → EU ranged 159 / 182 / 248–265 ms by the HK
provider's route**, and Singapore → Gravelines direct (148–162 ms) beat Singapore → HK gateway →
hub. That is where the §4 effective-latency rule comes from. Operator lesson: mtr-test a gateway
provider's route to the hub on a monthly term before committing.

#### 13.13.2 Seeds v3 and the moved hub's own region (`lib/db.js`)

**Seeds v3** adds `hkg` Hong Kong, `sin` Singapore and **`cqf` Gravelines** — seeded INACTIVE on
grinium domains only, like every seed. `cqf` is the IATA code of Calais–Dunkerque, the airport
nearest OVH Gravelines (~15 km); `gra` and `lil` are the obvious wrong guesses and the code comment
says so.

**The trap it had to fix (F3).** The old hub (local region `nyc`) seeds `cqf` inactive, and
`ensureLocalRegion` deliberately never re-activates a row — that rule is what keeps an operator's
"switch this region off" from being undone by a restart. So a hub moved to `cqf` would have stayed
**unpublished** forever: no connect card, no map marker, and nothing in any log. The fix persists
the local region the DB last saw (`pool_config` `_state`/`local_region`). When the configured
local region **differs** from the stamp, the new row is activated **once** and the stamp updated,
in one transaction; the old row is left alone (that box may become a gateway). A restart with an
unchanged region still never re-activates anything. **No stamp means unknown, not "moved"**: it is
only stamped, never used to activate — otherwise every upgrade of an existing pool would re-publish
a row its operator had switched off. That is why Migrate IN writes the OLD tag as the stamp when an
archive predates the stamp (§13.13.4). ⚠ `ensureLocalRegion` runs for `singlebox` only; a
mining-less `hub` role has no local row.

#### 13.13.3 Gateways follow a hub IP change — the re-resolve timer (F1)

WireGuard resolves a hostname `Endpoint` once, at `wg-quick up`, and a gateway writes a static
`Endpoint`. So "gateways reconnect with no action" was only true when the hub kept its IP (§13.10c,
now corrected). A gateway now installs `grin-gateway-reresolve` (a oneshot service + a 60 s timer,
`AccuracySec=5s`), the same logic as WireGuard's upstream `contrib/reresolve-dns`: if the peer's
endpoint is a hostname and its last handshake is older than 135 s, `wg set … endpoint host:port`,
which makes WireGuard resolve the name again. Design choices, each with a reason:
- The source is the rendered WG conf (what `wg-quick` actually loaded), not `grin_gateway.json`.
- A key that is not on the interface is **skipped**, not set — `wg set peer <unknown>` would ADD a
  peer.
- The unit keeps `CAP_NET_ADMIN` and deliberately has **no** `PrivateNetwork` (a private netns has
  no wg interface, so the unit would succeed while doing nothing) and no `PrivateDevices`
  (`/dev/log`).
- It is installed by `3) Bring up tunnel`; existing gateways get it the next time the operator
  runs `3)`. `5) Status` warns when the endpoint is an IP literal, and the hub prints a warning
  under every `GRINGW1` pairing string while `wg_endpoint_host` is empty.

**F2 — the old hub's tunnel must go DOWN at cutover.** Re-resolve fires only on a stale
handshake. While the old hub still answers, handshakes stay fresh and every gateway stays attached
to the old box. Migrate OUT therefore stops *and disables* the hub's `wg-quick@` unit.

**What a hostile DNS answer can do:** WireGuard's key authentication still holds, so a wrong IP
cannot impersonate the hub; the tunnel simply does not come up until DNS is right. The
re-resolve timer adds an availability dependency on DNS, not a confidentiality one. (The
adversarial review should confirm that reading.)

#### 13.13.4 Migrate OUT / Migrate IN — the order IS the safety design (F4)

Menu `B → 6` (old hub) and `B → 7` (new box), in `scripts/lib/07_lib_pool_migrate.sh`. The one
outcome it exists to prevent is **two live pools on one wallet seed**: two hubs both accepting
shares means two ledgers owing the same miners, and two wallets spending the same outputs. Every
step is ordered around that.

**Migrate OUT** (typed `MIGRATE`):
1. **Preflight, read-only.** In-flight withdrawals are listed using the statuses the *deployed*
   scheduler itself treats as pending. They are not a hard stop — the DB and the wallet are
   snapshotted *after* the stop, so they move together — but a second typed `PROCEED` is needed.
2. **Freeze payouts first**, before anything stops, so the scheduler cannot start a payout while we
   wait. It is the same SQL the restore uses, now one shared helper (`pbk_freeze_payouts`), so the
   two can never drift. A freeze someone else had already set is kept in the manifest
   (`payout_control.before`), so its reason is not lost.
3. **Wallet evidence**: the watchdog cron and `@reboot` line are removed *first* (the 5-minute
   watchdog would otherwise relaunch the listener during a minutes-long `info`), then the listener
   is stopped, then `grin-wallet info` runs as the service user with the passphrase on stdin.
4. **Stop and disable** the pool service, the hub WireGuard (stop the `wg-quick@` unit, not just
   `wg-quick down`, or the rollback's `enable --now` is a silent no-op — F2), and the daily backup
   cron (it writes the SAME archive name and would replace the migration archive). The node keeps
   running.
5. **Manifest** in the app dir, so it rides inside the archive: net, source IP, domain, local
   region + its stamp, WG endpoint, node height, wallet evidence, and ledger continuity figures —
   counts, sums, max ids **and per-row sha256 digests** of accounts, blocks, withdrawals and
   balance_log.
6. **Strict archive** (every critical path that exists must be in it) plus a `.sha256` sidecar,
   verified by decrypting it again. **D4: the Let's Encrypt material rides in this archive only**
   — `live/` symlinks stored as symlinks, `archive/`, the renewal conf, and `accounts/` (renewal
   conf names an account id; without it the first renewal on the new box fails ~60 days later).
   Daily backups still exclude certs.
7. Optional push to the new box by scp (remote sha256 compared).
Any failure after step 2 leaves the pool **frozen**, prints the state and a resume ("run B → 6
again" — every step is idempotent) and the rollback commands. Rollback is valid only while the
new hub has accepted no share and paid nothing.

**Migrate IN** (typed `MIGRATE`, or `CHECK` for the read-only box checks):
- **Run `CHECK` before Migrate OUT.** A missing install, an unsynced node, or an unwired node
  stratum (only a node restart fixes that) is fixed while the old hub still serves, not inside
  the downtime window.
- **Archive + manifest gate.** The newest archive with a sidecar is the default; the manifest's
  `archive_name` must equal the archive's name (a later daily archive of a once-migrated box
  carries the old manifest), an old manifest needs `PROCEED`, the node must be at or past the
  manifest's height, and a **clobber guard** refuses to overwrite a local ledger that has newer
  shares unless `OVERWRITE LEDGER` is typed.
- **Dark gate.** IN refuses to start while the old hub answers — a TCP dial of its stratum AND a
  pinned `https://<domain>/api/health` to the old IP that must *parse* `status: ok` (an HTTP 200 is
  not proof). **Dark needs the old box's own "no" on both:** a TCP RST from its stratum port, and
  an HTTP answer from its :443 that is not the pool (Migrate OUT leaves nginx up, so a dark hub
  answers 502). A firewall answers for a box too — a DROP times out, firewalld's default reject
  says "No route to host" — so a timeout, a no-route or a :443 that answers nothing is **unknown**,
  never dark, and needs a typed `OLD HUB IS DARK` (review C6). The probe runs again immediately
  before the pool starts. Same public IP = a rebuild in place, skipped.
- **The restored pool cannot start by accident.** 1) Install enabled the pool unit; IN disables it
  before extracting and only step 7 enables it again, so a failure plus a reboot never starts the
  old hub's seed unattended (review C2). Backend code (`index.js`, `package*.json`) is never taken
  from an archive — this box's checkout is kept (review C3).
- **Restore frozen** (`frozen_by` = `migrate-in`), then the new location (tag, label, country,
  lat/lng; writes the old tag as the F3 stamp when the archive has none), then bring-up: secret
  self-heal, the grin-wallet binary pinned to the restored version, web files, tunnel, nginx.
- **Continuity** compares 18 ledger figures, the per-row digests and the wallet identity with the
  manifest, using the *manifest's* in-flight SQL (newer code must not make equal ledgers differ).
  A sum + count match alone would pass two swapped balances; the digests do not. The wallet must
  refresh from this node and match the recorded total. **Any ✗ stops before the pool starts.**
- **Start**, then a DNS screen listing exactly which records to change, then a watch screen per
  region (handshake age, last share, miners). Unfreezing is **never** done here: reconcile, then
  resume in admin → Payouts.

**Downtime estimate (never measured):** ~15–30 min of miner downtime — OUT 3–8 min (the wallet
refresh dominates) + IN 5–12 min + DNS 1–5 min at a 60 s TTL; gateways follow ~2–3 min after DNS.
The testnet rehearsal must measure it.

#### 13.13.5 Connect-page latency — estimate first, measurement wins

Decision: **show an estimate instantly, replace it with the browser's own measurement, fall back
to the estimate.**

**A — the estimate** (`GET /api/pool/connect/suggest`, `lib/connect-suggest.js`). The viewer is
placed at their **country centroid** (geo-IP, country level only). A server sits at its declared
lat/lng, else its country centroid. RTT ≈ great-circle km × 0.015 ms (calibrated against the
2026-09-23 Globalping set; within ±25% of every sample). A gateway's figure is viewer→gateway **+
`hub_rtt_ms`**; the direct figure is viewer→hub. Offline regions, gateways with no measured
`hub_rtt_ms`, and rows with no position are skipped. **Same-country trap:** seeded rows carry no
lat/lng, so a seeded gateway sits exactly where a same-country viewer is placed — 0 km, i.e. every
US visitor "inside" the NYC datacenter. A centroid-placed server in the viewer's own country is
therefore given a typical in-country distance instead. It is still crude: **operators should
declare lat/lng on every gateway row** (admin → Regions). Privacy: the IP is resolved to a country
for this one computation and dropped — not stored, logged or echoed, and nor is the country;
`Cache-Control: private, no-store`.

**`hub_rtt_ms`** (on `/api/pool/stats/regions`) is the minimum of the last 5 successful TCP
connects from the hub to each gateway's **public** stratum port — about one hub↔gateway RTT on
the path the tunnel takes, but not the tunnel itself. `0` on the hub's own row, `null` before a
first successful probe. `is_hub` marks the direct row (on a `singlebox` only).

**B — the measurement.** Each server answers `GET /ping` with an empty **204**, CORS `*` and
`Timing-Allow-Origin: *` so the page can read Resource Timing cross-origin.
- **Hub:** a `/ping` location in the main vhost, via a named location — a bare `return` runs in
  nginx's rewrite phase, *before* `limit_req`, so it would never be rate-limited (measured on nginx
  1.24: 40 rapid requests → 40 × 204 bare vs 20 × 204 + 20 × 429 this way). Behind a CDN the hub
  cannot be timed directly, so the operator may set `latency_hub_url` to a DNS-only name under the
  probe domain; unset behind a CDN = the hub keeps its estimate.
- **Gateway:** `6) Latency probe` runs a **separate** HAProxy instance (`grin-gateway-probe`), not
  a frontend inside the forwarder — the forwarder's pre-start `haproxy -c` covers its whole config
  (a bad or missing pem would stop stratum), and it has no reload (every certificate renewal would
  drop every miner). It serves one 204 route, 30 requests / 10 s per IP, TLS ≥ 1.2, no logs, no
  backend. Its certificate comes from certbot standalone, so `:80` is bound only for the seconds of
  an issue or renewal.
- **CSP.** The public page's `connect-src` gains `https://*.<probe_domain>`. `probe_domain` is the
  pool's own subdomain and **never derived wider** (a public-suffix trap: `pool.example.co.uk` →
  `co.uk`); `latency_probe_domain` may name a *parent* of it, nothing else. The admin CSP stays
  `connect-src 'self'`.
- **The page** (`reactor-dashboard.js`) measures once the connect panel is first in view: a
  warm-up, then 3 sequential probes → the minimum; a failed warm-up ends it (an unanswering host
  would otherwise cost four 2.5 s timeouts); only a 204 counts. A gateway's measured figure is
  its leg **+ `hub_rtt_ms`**. Results are cached per URL for 10 min in sessionStorage; a rate-limited
  **Re-test** control re-measures. The ranking rule (`pickRecommended`, direct wins within the bias)
  is one function in `lib/connect-suggest.js` with a copy in the page, and the page takes the bias
  from `/api/public/branding` → `connection.latency.direct_bias_ms`, so there is no second literal;
  a test runs both copies on 2,000 generated cases.

**Known limits (for the review):** a ranking that mixes a measured row with an estimated row
compares two instruments, so the estimate's ±25% can flip a near tie; a gateway probe name proxied
through a CDN would answer from the CDN edge and read as near — only DNS-only probe names mean
anything.

#### 13.13.6 Still open

- **Adversarial review — DONE 2026-09-23** (audit Status roll-up, "Part 9 review"). Fixed, each
  proven by a failing harness scenario first: a Migrate OUT across local midnight made its own
  archive unusable to Migrate IN (C1); Migrate IN left the pool unit that 1) Install enabled
  enabled across a failure, so a reboot started the restored pool (C2); archives carried
  `index.js`/`package*.json`, so a restore mixed two code versions (C3); `2) Restore` froze nothing
  after a failed extraction (C4); Backup now and the daily cron could write an archive without
  pool.db (C5); the dark gate took a firewall's reject for the old box's own "no" (C6 — now only a
  RST on stratum plus an HTTP answer that is not the pool proves dark). The two build-found items
  C4/C5 are among those fixes.
- **Fixed 2026-09-24 (P1):** the weekly VACUUM's EXIT trap restarts a pool it stopped, so a move
  started mid-vacuum got its old pool back. Migrate OUT step 4 now removes that cron first and
  refuses while a vacuum runs.
- **Reported, not changed** (review P-items): a stale-but-self-consistent archive after a rollback passes IN (P2); the dark
  gate probes the old box's egress IP (P4); `2) Restore` leaves the wallet watchdog able to
  relaunch the listener mid-extract (P5); the old `nyc` row can be recommended as a "gateway" until
  it is deactivated (P7). Still open from the build: plain `2) Restore` leaves an enabled cert-less
  vhost (Migrate IN disables it); a digest that errors is `null` → `skip`; the ufw rules for the
  per-region ports on the wg interface are not checked; `/api/pool/topology` keeps its own copy of
  the status rules; the public CORS `*` also applies to the per-viewer suggest route; the old box's
  certbot keeps attempting renewals after DNS moves (noise, gone at wipe).
- **VPS acceptance:** testnet rehearsal of the whole move (including a stale archive and a live
  old hub, to prove the refusals), a re-resolve drill, one gateway's latency probe live, then the
  mainnet move. The old box then stays dark ~7 days before it is wiped — and may be rebuilt as the
  `nyc` gateway, whose seeded row is untouched.

---

## 14. Data retention & ledger rollup — IMPLEMENTED 2026-07-16 (branch `add-ons`; NOT VPS-tested)

Industry-standard three-tier retention (mirrors Miningcore/NOMP/commercial pools: raw shares
ephemeral, daily earnings kept for years, blocks/payouts forever). Keeps the SQLite file at a
**bounded steady state (~2–4 GB modest / ~8–12 GB at 1000-miner scale)** instead of unbounded
growth (~30+ GB/yr raw), while every *lifetime* public/audit figure stays exact forever.

### 14.1 What is kept, what is pruned

| Tier | Table | Retention | Why safe |
|---|---|---|---|
| working buffer | `shares` | height floor: confirm_depth + PPLNS 60 + `shares_margin_blocks` (default 360 → ~31 h) | PPLNS + orphan reversal read nothing older; luck/effort snapshotted into `blocks.network_difficulty`/`round_shares` at find time |
| display detail | `hashrate_history` | `hashrate_keep_days` (100) | per-miner wiggle-line only; pool-wide trends live forever in `pool_metrics_hourly` |
| **ledger detail** | `balance_log` | `balance_log_keep_days` (default 60, **floor 45**) | rolled into `balance_log_daily` first, verify-before-delete (14.2) |
| aggregates | `pool_metrics_hourly`, `balance_log_daily` | **forever** (~1 MB/yr + ~150 MB/10 yr) | size independent of miner count × time detail |
| money record | `blocks`, `withdrawals`, `withdrawal_events`, lottery | **forever** (~50 MB/yr) | the actual audit/tax record; payouts also mirrored on-chain |

Floor 45 on `balance_log_keep_days`: raw-only readers use windows up to 30 d (reconciliation
wallet-send audit `window_days=30`, account earnings 30 d, payments day/week/month ranges) + slack.

### 14.2 Ledger rollup — `lib/ledger-rollup.js` (the one contract to remember)

`balance_log_daily (day, grin_address, event_type, reference_type, total_amount, event_count)`
— these dimensions exactly reconstruct every lifetime consumer (verified by test, 14.4).

**Horizon contract:** marker `pool_config('_state','balance_log_rollup_horizon')` = **H**
(UTC-day-aligned) ⇒ rollup fully covers `created_at < H`. Composite lifetime reads =
`rollup(day < H) + raw(created_at >= H)` — no gap, no double-count, at every prune state.
Window reads with cutoff ≥ now − keep_days may read raw only.

Retention pass (hourly, `lib/retention.js`): ① `rollupCompletedDays` — whole completed UTC days,
idempotent replace-on-conflict, marker advanced in the same tx; ② `verifyAndPruneRaw` — deletes
one day at a time, **only after** that day's raw COUNT/SUM matches its rollup; a mismatch halts
pruning (`ledger_rollup_mismatch` in retention status/log) and never deletes an unverified day.
Rollup rows are never pruned. File space reclaimed by the weekly VACUUM cron, as before.

### 14.3 Consumers repointed to composite reads (all in this change)

- `hashrate-tracker.getPaymentsHistory` — lifetime totals (fee %, to-miners, giveaways) always
  composite; `year`/`all` series merge rollup+raw **additively** per bucket (a week/month bucket
  can straddle H); day/week/month ranges stay raw-only (≤30 d < floor 45).
- `lib/reconciliation.js` — lifetime flows, `pool_fee`/`prize_pool` funding detail, and the
  **integrity invariant** (Σledger vs Σbalances, feeds auto-freeze) are composite; d1/d7 raw.
- NOT repointed (verified within raw window): account earnings 1h/24h/7d/30d, ledger statement +
  CSV (row detail now labeled "kept 60 days", presets 30/60/all-retained), incentives jackpot
  dedup, prize-pool activity feed.

### 14.4 Chart/stat ↔ retention audit (2026-07-16, all pages)

| Surface | Source | Longest window | Verdict |
|---|---|---|---|
| Dashboard strip-chart + 24h peak, KPIs, top-miners 1h | `hashrate_history` 24 h; `shares` ≤24 h | 24 h vs ~31 h shares floor | ✅ (height-based prune fails toward *keeping more*) |
| miners-stats trends Day→All-Time | `pool_metrics_hourly` | all-time | ✅ forever |
| miners-stats leaderboards (30 d) | `blocks` / `hashrate_history` | 30 d vs forever/100 d | ✅ |
| blocks page explorer + P-01…P-04 (incl. luck) | `blocks` (+ snapshot cols) | all-time | ✅ forever |
| payment-history tiles + 4 charts, every range | `withdrawals` + composite ledger | all-time | ✅ exact via rollup |
| account P-01 hashrate (Day/Week/Month) | `hashrate_history` | 30 d vs 100 d | ✅ (Year/All already disabled with note) |
| account earnings / ledger cards | raw `balance_log` | 30 d vs 45-floor | ✅ |
| account P-06/P-07 row ledger + CSV | raw `balance_log` | keep_days | ✅ labeled; older detail = daily granularity |
| admin reconciliation + money alerts | composite + raw d1/d7; wallet-send audit 30 d | ✅ |
| lottery/campaign eligibility | `hashrate_history` | campaign window | ✅ while campaigns ≤ `hashrate_keep_days` (100) — enforce if longer campaigns are ever added |

**Smoke-tested** (scratchpad `test-ledger-rollup.js`, node:sqlite): synthetic 90-day ledger
(1526 rows) → rollup + prune to 45 d (763 rows deleted) ⇒ payments `all` totals, `year` series
bucket-by-bucket, reconciliation lifetime flows, fee/prize buckets and `integrity_drift = 0`
all **identical** before/after; re-run is a no-op. NOT yet run against a live VPS DB.

### 14.5 Size forecast (5–7 yr, with this design)

Modest pool (~20 blk/day): **2–4 GB** total. Large pool (1000 miners, ~400 blk/day): **8–12 GB**
— dominated by *constant-size* working windows (shares ~1 GB, hashrate ~1.5 GB, raw ledger 60 d
~4–5 GB), plus slow-growing forever-tables (~0.2 GB/yr). Deferred (size-only, not correctness):
vardiff (bounds share-row rate), per-miner **hourly** hashrate rollup w/ optional `worker_name`
dimension (would allow cutting `hashrate_keep_days` and enable per-rig history >24 h — worker
detail today exists only in `shares`). Optional future: yearly SQLite/CSV cold archive of pruned
raw ledger as a public transparency download.

---

## 15. Goblin nickname payouts over Nostr — DESIGN ONLY (2026-07-17, NOT built)

Operator idea: on the account page, a miner passes the ownership gate, enters their **Goblin
wallet username** (e.g. `alice` → `alice@goblin.st` via NIP-05), and the pool delivers the
payout slatepack to their Goblin wallet over Nostr — no Tor listener, no manual copy/paste.
Decision 2026-07-17: **design first, build later** (after the current batch is VPS-tested).

### 15.1 Why it's feasible (verified groundwork)

The slatepack-over-Nostr wire format was SOURCE-VERIFIED 2026-07-09 against goblin
`src/nostr/*.rs` (full detail → `script05_design_goblin.md`, memory
`reference_goblin_ecosystem`). Facts that matter here:

- **Payload**: NIP-17 private DM — kind-14 rumor, content = `"[Goblin] GRIN payment message …"`
  preamble + blank line + **plain-armor** slatepack (confidentiality = the DM layer, so the
  pool's existing `recipients: []` slatepack creation is byte-compatible). Tags `["goblin","1"]`.
  Caps: rumor 32 KB, slatepack 30 KB, note 256 chars.
- **Encryption**: standard **NIP-44 v2 always works** (goblin's "v3" is its own negotiated
  extension, only used when the peer advertises it — a Node bridge never needs it).
  `nostr-tools` (nip44/nip59/nip17/nip05 + SimplePool over ws) covers everything.
- **Ingest**: goblin AutoReceive (default policy Everyone) signs S2 automatically when the
  wallet is online; it finalizes only if the sender pubkey == stored counterparty ⇒ **the pool
  must send from the same Nostr key it listens on** (one persistent pool identity key).
- **Relays**: shared floor `wss://relay.floonet.dev` is pinned in every goblin publish+inbox
  set (plus relay.0xchat.com, offchain.pub). Public wss — no relay of our own is required
  (the 091 floonet-rs deployer stays optional compose-when-present).
- **Timing**: goblin pending-send expiry is **24 h**; catch-up lookback 3 days (wrap
  `created_at` fuzzed ≤ 2 d past). Pairs naturally with our slatepack TTL expiry/refund.

### 15.2 The security tension — this rail pays a THIRD PARTY

Every existing rail can only pay the miner's own wallet: Tor dials the mining address's
`.onion`; the manual slatepack is age-encrypted **to the mining address**. That is why the
ownership gate is anti-griefing, not authentication — a passed gate cannot redirect funds.
A nickname rail breaks that invariant: coins go to **whoever controls the npub** behind the
username. A guessed IP (CGNAT neighbour!) or a leaked rig password would become real theft.
The IP-or-password gate MUST NOT be the only thing standing between an attacker and an
arbitrary-destination payout.

**Mitigation — registered destination + cooldown (exchange-style address whitelisting):**
1. `POST /api/account/:addr/nostr-destination` (ownership-gated, rate-limited): resolves the
   NIP-05 username → npub, stores `{username, npub, registered_at}` on `miner_accounts`,
   audit-logs the change. Re-registration overwrites and **resets the clock**.
2. A Nostr payout is allowed only when `now - registered_at ≥ cooldown` (config, default
   **48 h**, operator-tunable ≥ 24 h). Until then the account page shows "activates at <UTC>".
3. The pending registration is prominently visible on the account page (and in the account
   audit trail), so the legitimate owner — who checks their stats — has the whole cooldown
   window to notice a hijack attempt, re-register (clock reset evicts the attacker's entry),
   and rotate their rig password.
4. Registration + first use each raise an admin money-alert (reuses AlertMonitor channels);
   per-rail spend caps can piggyback on the existing large_withdrawal alert.
5. The npub is pinned at registration time (TOFU): at send time the pool re-resolves the
   NIP-05 name and **refuses if the npub changed** (a goblin.st account takeover must not
   silently redirect payouts — the miner must re-register through the gate + cooldown).

### 15.3 Bridge module sketch (`lib/nostr-payout.js`, in-process — no separate daemon)

- One pool Nostr identity key (generated at setup, stored like `.wallet_pass`; NEVER the
  operator's social `nostr_link` key from branding).
- `SimplePool` over `wss://relay.floonet.dev` + 2 fallback relays (operator-configurable
  JSON list in pool_config; compose-with-091 just prepends the self-hosted relay).
- Send path (piggybacks the existing slatepack state machine — NEW `method='nostr'` rows
  reuse `slatepack_pending`): create S1 (same wallet call as the manual rail, `recipients:
  []` plain armor) → wrap per NIP-17 (kind-14 rumor → NIP-44 v2 seal → gift wrap) → publish
  to the destination's inbox relays (kind-10050 lookup, fallback to the shared floor).
- Receive path: persistent subscription for gift wraps addressed to the pool key; unwrap →
  regex-extract exactly ONE `BEGINSLATEPACK` block (tag-distrusting, same as goblin) →
  classify by parsed slate state → if it's S2 for a `slatepack_pending` nostr row, run the
  existing finalize path (same code as the manual rail's finalize, minus the HTTP route).
- Failure states map onto what already exists: no S2 within TTL → the standard slatepack
  expiry refund (goblin's own 24 h pending expiry means a dead wallet fails fast); relay
  publish failure → park as `retry_scheduled` and reuse the Tor retry ladder; NIP-05
  resolution failure or npub mismatch → 4xx at request time, nothing locked.
- Freeze/kill-switch: `_assertNotFrozen()` gates the new entry point exactly like the other
  rails; the reconciliation coverage math needs no change (locked balances behave identically
  to the manual slatepack rail).
- **Pending exclusivity + cooldown come for free.** Because `method='nostr'` rows park in
  `slatepack_pending`, they are already counted by the shared `PENDING_SQL`, so the
  one-pending-per-address rule holds across Tor + slatepack + Nostr with no new code — a miner
  can never run a Nostr payout alongside another rail. The nostr create entry point must also
  call `_assertNoRecentReversal()` (added round 3, 2026-07-17) so the failed-payout cooldown
  spans this rail too; a Nostr failure that reverses the lock goes through the same
  `_reverseLock` → `balance_log` reversal row that arms the cooldown. This is the concrete
  payoff of "reuse the withdrawal state machine": the cross-rail double-pay guard already
  covers a rail that isn't built yet.

### 15.4 Build order (when green-lit)

1. Schema + registration endpoint + cooldown + account-page UI (no sending yet) — smallest
   reviewable slice, and the cooldown clock can already be running for early adopters.
2. Bridge send/receive with a testnet goblin wallet against the public relay floor.
3. Alerts + admin visibility (registered destinations list, per-rail counters).
4. VPS E2E with a real Goblin wallet, then enable on mainnet behind a pool_config flag
   (default OFF).

Est. scope: ~1 session for slice 1, 1–2 for the bridge. Deps: `nostr-tools` (+ `ws`) — the
only new npm packages; everything else reuses the existing withdrawal state machine.

### 15.5 BUILT 2026-07-18 (add-ons, NOT VPS-tested) — what shipped vs the sketch

Implemented as one in-process bridge `lib/nostr-payout.js` + a `method='nostr'` rail on the
existing scheduler. Feature flag `nostr_payouts_enabled` defaults **OFF**; nostr-tools + ws are
lazy-required inside `start()` so a pool without `npm install` (or with the flag off) boots
normally. Deviations from the sketch, all deliberate:

- **Send-only rail (no donation-receive).** The pool is always the payout *sender*; the bridge
  subscribes for the S2 *response* only. The §3.2 donation-ingest flow is out of scope here
  (that was a Drop feature) — the receive pipeline finalizes S2s for our own pending sends and
  drops everything else.
- **S1 is plain armor (`recipients:[]`)** — the ONE wallet-call difference from the manual
  slatepack rail (which age-encrypts to the mining address). Confidentiality is the Nostr DM
  layer, and goblin's AutoReceive expects plain armor (§2.4). Everything else reuses
  `createSlatepackWithdrawal`'s lock/fee/expiry machinery verbatim.
- **Publish failure reverses immediately** (status `nostr_failed`) rather than entering the Tor
  retry ladder (which is Tor-transport-specific). Simpler and safe: the miner just re-requests.
  A *delivered but unanswered* send still parks in `slatepack_pending` and refunds via the
  normal TTL sweep, so a genuinely-offline wallet is covered.
- **NIP-05 domain allowlist** (`nostr_nip05_domains`, default `["goblin.st"]`) added as an
  explicit SSRF + look-alike-domain guard beyond §2.6's hostname validation — the pool will
  only resolve a username against an allowlisted domain.
- **TOFU re-pin at send time**: the route re-resolves the stored username and refuses the
  payout if the npub changed since registration (§15.2 #5), on top of the ≥48 h cooldown.
- **Response binding is defence-in-depth**: the bridge routes an incoming S2 to a pending row
  by matching the seal-sender pubkey to the registered `nostr_npub`; the scheduler then
  re-checks that match AND binds `slate.id` before finalizing. The bind fails CLOSED (since
  2026-09-27, on the manual rail too): a row that has no slate id yet, or a reply that decodes to
  none, is refused. It used to be skipped, which let a refunded slate's reply be finalized through
  a new row (impl §10.10 *Slatepack finalize binding*).

Files: `lib/nostr-payout.js` (bridge, all nostr-tools calls isolated in a "wire" section),
`lib/withdrawal-scheduler.js` (`createNostrWithdrawal` / `finalizeNostrWithdrawal` +
`nostrBridge` injection), `index.js` (startup construct+start, response-handler wiring,
`POST`/`DELETE /api/account/:addr/nostr-destination`, `method:'nostr'` withdraw branch,
account-summary `nostr_destination` + `nostr_payouts_enabled`), `lib/db.js`
(miner_accounts `nostr_username`/`nostr_npub`/`nostr_registered_at`, `nostr_seen_events` dedup
table created by the bridge), `lib/config.js` + `lib/pool-settings.js` (4 config keys),
`admin-panel/settings-payout.html` + `settings-common.js` (admin fields),
`public_html/account-settings.html` (P-04 Goblin option + registration UI). Security detail →
security_audit §E.3; build notes → implementation §10.2.

### 15.6 OFF-BY-DEFAULT IS A GUARANTEE, NOT A DEFAULT VALUE (verified 2026-08-13)

Goblin is a third-party rail depending on relays we don't run and wallet software the miner
installs separately, so a pool that has not deliberately switched it on must show **no trace of
it to an end user**. Four independent layers enforce that; all four were re-verified 2026-08-13.

1. **Default** — `payout.nostr_payouts_enabled: 'false'` in `lib/pool-settings.js`, with a
   validator that accepts only `true`/`false` and normalises an empty or absent value to
   `'false'`, never to truthy. The admin checkbox in `settings-payout.html` ships unchecked.
2. **The account summary reports RUNTIME truth, not the setting.** `index.js` sends
   `nostr_payouts_enabled: !!(nostrBridge && nostrBridge.isEnabled())`. So a pool where the
   operator ticked the box but `npm install` never ran — the bridge constructor throws and is
   caught, leaving `nostrBridge = null` — reports **false** and the UI stays hidden. A flag that
   is on while the feature cannot work must never render a payout option.
3. **Markup fails closed.** All three Goblin blocks in `account-settings.html` (radio `<label>`
   :472, payout pane :509, destination card :561) ship `style="display:none;"`, so nothing appears
   before the summary lands and there is no flash of an unavailable rail. `PayoutMethods.applySummary`
   reveals the label and the destination card only when `isEnabled(summary)` passes, unchecks the
   radio if the rail is switched off while it was selected, re-checks the `fallback` rail (Tor),
   and hides the whole `#acct-destinations` heading when no destination card is visible. The
   **pane** is not driven by `isEnabled` at all — `sync()` shows whichever pane matches the
   *checked* radio, and a disabled rail's radio can never be the checked one. Worth knowing before
   adding a rail: a pane with no radio would never be hidden by this machinery.
4. **The server refuses regardless of what the page shows** — `503` on
   `POST /api/account/:addr/withdraw` with `method:'nostr'` (index.js :3520) and on
   `POST /api/account/:addr/nostr-destination` (:3642). Hiding a control is presentation; this is
   the actual gate, and it holds against a hand-crafted request. **`DELETE /nostr-destination` is
   deliberately NOT gated** — de-registration cannot redirect money, and a miner must still be able
   to clear a pinned destination after the operator switches the rail off, or the pin is stranded
   in `miner_accounts` with no route to remove it.

**One leak existed and was fixed 2026-08-13:** `public_html/index.html` carried a static line
—"Nostr / Goblin transport planned"— rendered to every visitor irrespective of the flag, and stale
besides (the rail shipped 2026-07-18). Removed. The homepage now describes only the two rails
every pool always has. **Rule: no public page may name an optional rail in static copy.** The
account page is the only surface allowed to mention Goblin, because it is the only one that
gates on the summary.

Not a leak, and deliberately kept: a *withdrawal history* row whose `method` is `nostr` keeps
rendering "Goblin (Nostr)" after the rail is switched off. That is the miner's own past payment,
and `payout-methods.js` falls back to the raw method string for a rail that no longer registers,
so history never renders `undefined`.

> Unrelated near-miss when grepping: `data-brand="social-nostr"` in `index.html` /
> `public-shell.js` is the pool's optional **Nostr social link** in the footer (`branding.nostr_link`,
> also hidden by default). It has nothing to do with the payout rail — do not wire the two together.

---

## 16. Donor names + donor league — DESIGN (2026-09-21; Parts 1–5 BUILT + reviewed the same day, NOT VPS-tested)

> **⚠ Superseded in part by §18 (2026-09-23, design only).** The donation becomes per SHARE (no
> stored %, no ceremony), the worker label stops being a donor name, and names + banners move to a
> reviewed donor profile on the account page. The ranking (§16.6) and expiry survive. Read §18
> first; this section is the record of v1 and of what is still built today.

Operator idea, settled in discussion 2026-09-21 after the first live-miner test of the donate
tag: let a donor put a **brand name** on the public donor wall (`donate.html` D-03), make the
wall **competitive** (amount × loyalty), and keep every donor forever with **post-moderation**
from the admin panel rather than a review gate. Six build sessions; the per-session prompts are
kept outside the repo (plans dir) and fold back here when run. Status per part → §16.11; what
building changed against §16.1–§16.10, and the independent review's findings → §16.12. §16.1–§16.10
are left as designed — read them with §16.12 beside them.

### 16.1 Decisions (all FINAL unless a build finds a hard reason)

| # | Decision | Why |
|---|---|---|
| 1 | Name comes from the **worker label** of the tagged rig: `yourbrandname-donate10` → name `yourbrandname`; plain `donateN` → **masked address** (as today) | Register-free, no new UI for the miner; the tag already lives in the worker name (§J3-5) |
| 2 | Name is written **only on a set-from-zero** (`donate0` → `donateN`), the same path as a raise (§J6-7). A lower never touches the name | Stratum login is unauthenticated; without this anyone can rename any active donor by mining four shares to their address |
| 3 | **Post-moderation, accept-all by default.** A name shows as soon as its card exists; the operator censors after the fact | The cheapest way to put text on this page is to donate GRIN and wait for a block ("cost to post"); a review queue would gate the honest 99 % for the troll 1 % |
| 4 | Censor is **per address and sticky**: a censored donor's later renames stay censored until an admin clears it. Un-censor sets an `allow` override the auto-list respects | Otherwise it is whack-a-mole |
| 5 | Censored / expired / absent name → the card shows the **masked address** by default; `<censored-donor>` is an operator setting, off by default | A visible "censored" marker is the reaction a troll wants and makes the wall look like it has a problem |
| 6 | **Auto-censor word list** ships as a starter (impersonation words + compact English profanity), editable in admin; saving **re-scans** every name | Never complete, English-only — the operator's own words are the real list |
| 7 | Ranking **score = GRIN in window × (1 + loyalty% × active months)**, multiplier capped; ties by months ↓ then first donation ↑ | A strict amount → duration → rigs priority never reaches the second key: 9-decimal amounts never tie |
| 8 | **Active months** = distinct UTC months with ≥ 1 donation **debit** | "Months since first donation" rewards a one-off; "months the tag was on" costs nothing on an idle rig; a debit costs GRIN |
| 9 | Window default **365 days** (setting; 0 = lifetime). Lifetime GRIN still printed on every card | A lifetime board freezes — the early big donor is #1 forever |
| 10 | **Rigs displayed, never ranked** | Renaming a worker is free and says nothing about generosity |
| 11 | Donors with nothing in the window leave the league for a capped **Past donors** strip; nothing is ever deleted and `Donors` / `Donated all-time` stay lifetime | The user's "prune by date" without removing a thank-you |
| 12 | **Name expiry**: masked address again 12 months after the last donation (setting; 0 = never) | Keeping the tag on is what keeps the name up |
| 13 | Names display **lowercase**; charset stays `a-z0-9_-` (no dots → no domains) | Login grammar has no case; the charset is the best free anti-spam rule we have |
| 14 | Worker part **case-folded** at login; visible label **32**, raw **48** (was 25 / 40) | `MyBrand-donate10` was *refused at login*; a 27-char brand clipped to `northern-hashwo-donate10` |

### 16.2 Login grammar (`lib/stratum-protocol.js validateUsername`)
`grin1…` + `.` + worker, worker lowercased **before** the regex (the address stays strict —
grin never emits uppercase bech32). `MAX_WORKER_NAME_LEN` 25 → 32, `MAX_WORKER_RAW_LEN` 40 → 48;
the existing rule "cut the label, keep the token" is unchanged, so beside `-donate100` a label
keeps ≥ 22 chars. Token parse unchanged (`(?:(.*?)[-_])?donate(\d{1,3})$`, 0–100 only, leading
zeros allowed, 4+ digits = plain name). `dm[1]` (the label) is what becomes the donor name.

### 16.3 Data model — six columns on `miner_incentives` (ALTER … ADD COLUMN, same helper pattern as `miner_accounts`)
| Column | Meaning |
|---|---|
| `donor_name TEXT` | lowercase label as captured; NULL = none |
| `donor_name_set_at INTEGER` | unix, when captured (drives the admin NEW badge) |
| `donor_censor TEXT` | NULL · `auto` · `admin` · `allow` (admin override — auto-list skips this address) |
| `donor_censor_word TEXT` | the list entry that matched, for the admin badge (`auto: "word"`) |
| `donor_censor_at INTEGER`, `donor_censor_by INTEGER` | unix + admin user id (NULL for auto) |
No new table. Lifetime totals, first/last dates, active months and rigs are all derived at read
time from the ledger composite (`balance_log_daily` + `balance_log`) and the 24 h share window.

### 16.4 Capture rule (`lib/stratum-server.js`, in the block that applies `session.donationPercent` after `PROOF_MIN_SHARES`)
Only when `setDonation` is called on the **from-zero** branch (`current === 0 && new > 0`):
`label = dm[1]` from the parsed login (empty → clear `donor_name` to NULL — a plain `donateN`
after a branded one removes the name). Then `lib/donor-names.js`:
1. `normalise(label)` — strip `-`/`_`, map leet `0→o 1→i 3→e 4→a 5→s 7→t`, lowercase.
2. Reserved (fixed in code, always applied): pool `pool_name` lowercased, `admin official
   operator support staff pool grinium prize jackpot winner`.
3. Operator list (`donor_name_blocklist`, one entry per line, matched as a **substring of the
   normalised name**).
4. Write `donor_name`, `donor_name_set_at`; if `donor_censor` is `admin` → leave it (sticky);
   if `allow` → leave it (override); else set `auto` + word on a match, or NULL.
Reserved and list hits are **stored, not refused** — the name exists, it just never displays.
`setDonation` itself is untouched (it still refuses reserved addresses and honours both flags).

### 16.5 Moderation model — three layers, in order of what they catch
1. **Cost to post** — a name displays only on a card with a donation debit (existing card rule).
2. **Auto-list** at capture and on every list save (rescan walks all `donor_name IS NOT NULL`
   rows, skipping `allow` and `admin`). False positives (`classic` ⊃ `ass`) are expected; the
   fix is the admin un-censor, which sets `allow`.
3. **Admin → Donors** page (§16.8): Censor / Un-censor per address, audit-logged
   (`donor_censor` / `donor_uncensor` in `admin_audit_log`, target_type `donor`).
Plus one public line under the wall: *"Names are chosen by the donors and are not verified by
the pool."* And the stranger case (decision 2) is closed at the write, not by moderation.

### 16.6 Ranking (`/api/pool/donors`)
```
W  = donor_rank_window_days (365; 0 = lifetime)
A  = GRIN donated inside W          (composite read; day-aligned for rolled days)
M  = distinct UTC months with a donation debit, lifetime
mult = min(1 + donor_loyalty_percent_per_month/100 × M, donor_loyalty_cap)   (10 %, ×3)
score = A × mult
league  = donors with A > 0, ORDER BY score DESC, M DESC, first_donated_at ASC, LIMIT 100
past    = donors with A = 0 (lifetime > 0), ORDER BY last_donated_at DESC, LIMIT 20 + count
```
Published on the page in one sentence. `totals` stay lifetime over every donor (fixed
2026-09-21, impl §10.3). `active_donors` counts live tags (same fix).

### 16.7 Public wall (`donate.html` D-03) — per card
rank (🥇🥈🥉 for the league top 3) · **display name** · GRIN in window · lifetime GRIN (when
different) · `×1.4 loyalty · 4 months` · `donating 10 %` / `paused` · since (first donation) ·
`N rigs online` (display only). **Display name** = `donor_name` when it is set, not censored,
and `last_donated_at` is inside the expiry — else the masked address, or `<censored-donor>`
when the operator chose that and the reason is a censor. The API emits `name` (or `null`) and
`name_state` (`shown` · `masked` · `censored` · `expired`) and **never** the censored string.
Past-donors strip: name/masked + lifetime GRIN + last donation, then "and N more past donors".

### 16.8 Admin → Donors (`admin-panel/donors.html`, NAV child of Dashboard after Miners)
Table (one row per address with a lifetime debit **or** a live tag; **full** addresses — admin
side): rank · score · address · donor name + state badge (`ok` / `auto: "word"` /
`admin-censored` / `allowed` / NEW < 7 d / `renamed while censored`) · current % · lifetime ·
in-window · active months · first / last · workers (24 h window, LED, tagged rig marked) ·
**Censor** / **Un-censor**. `AdminTable` controller, search + filter (all / censored / new).
Settings form on the same page (harvester, ids = keys): `allow_miner_donations` and
`donation_address` **move here** from `settings-incentives.html` (which keeps a link) ·
`donor_name_blocklist` (textarea) · `donor_censored_display` (`masked` | `marker`) ·
`donor_rank_window_days` · `donor_loyalty_percent_per_month` · `donor_loyalty_cap` ·
`donor_name_expiry_months`. Dashboard + nav show "N new donor names this week".
Routes: `GET /api/admin/donors` (secureAdmin), `POST /api/admin/donors/:addr/censor` and
`/uncensor` (freshAdmin, audit), rescan hooked into the settings save for the list key.

### 16.9 Miner side
`/api/account/:addr` gains `donor_name` + `donor_name_state`; the account page donation row
prints *Donor name: acme* · *hidden by the pool* (a false positive must know to contact the
operator) · *expired — reconnect with your tag to refresh*. Changing a name = the raise
ceremony (`donate0`, a few shares, `newname-donateN`), documented beside the raise row on D-01.
D-01 example row becomes `grin1…address.yourbrandname-donate10`.

### 16.10 Security notes for the audit pass
- **Stranger write** is bounded to paused addresses (decision 2) and costs 4 accepted shares
  paid to the victim; the address is masked so a hostile name on someone's card identifies
  no one but them; the victim clears it with the ceremony, the admin with a click.
- **Leakage**: `name` on a public feed is opt-in disclosure by the donor; the address stays
  masked (§J11-1); `test-public-leakage.js` must assert no full address and no censored string
  ever leave `/api/pool/donors` or `/api/account/:addr`.
- **Gaming**: months need a debit (GRIN); rigs are not ranked; the window resets the race.
- **Type traps** (memory `project_config_loader_type_traps`): every new numeric setting is
  parsed with a bound, `donor_censored_display` is a closed enum, the list is split on
  newlines and trimmed, never `eval`'d or used as a regex.

### 16.11 Status
| Part | Scope | State |
|---|---|---|
| 1 | Login grammar: case-fold, 32/48, `donor_label`, tests (D-01 example row moved to Part 4 with the rest of the page copy) | **done 2026-09-21, not VPS-tested** — impl §10.3 "Part 1"; guard suite 71/71 |
| 2 | Storage + capture + `lib/donor-names.js` + settings keys + account API/page | **done 2026-09-21, not VPS-tested** — impl §10.3 "Part 2"; `test-donor-names.js` 100/100. Two deltas recorded there: expiry counts from the later of last debit and capture (calendar months), and censor outranks expiry. `lib/donor-ledger.js` started early with the per-address `lastDonatedAt` so Part 3/4 extend one file |
| 3 | Admin: routes, audit, rescan, `donors.html`, settings move, dashboard count | **done 2026-09-21, not VPS-tested** — impl §10.3 "Part 3"; `test-donor-names.js` 148/148, admin-panel 71/71, admin-guards 79/79. Deltas recorded there: the admin list also shows STORED-NAME rows with no debit and no tag (moderate before the first debit publishes); un-censor from NULL and censor of a nameless address are both allowed (pre-emptive, sticky); renaming the pool re-scans too; the settings form is page-local so the rescan counts can be shown; the nav badge reads a one-COUNT `/api/admin/donors/summary`, not the dashboard route. §16.6's window edge is now stated: a rolled day at its UTC midnight ≥ cutoff is in WHOLE |
| 4 | Public: `/api/pool/donors` v2, D-03 league/past, copy, api-docs meta, leakage tests | **done 2026-09-21, not VPS-tested** — impl §10.3 "Part 4"; `test-donor-league.js` 68/68, leakage 77/77, admin-guards 79/79. The response is built by `lib/donor-ledger.js donorWall()` (the route is thin) with the address mask a REQUIRED argument; two implicit points now stated: past-strip ties break on lifetime DESC then address ASC, and a league overflow (>100 in window) is counted in `totals` but shown on neither list. 390 px iframe probe: 0 overflow on three page states |
| 5 | Review of 1–4 against this section + security notes; fold into docs + memory | **done 2026-09-21** (a separate cold session reading the working-tree diff) — the nine questions and their answers are §16.12; **two code findings, both fixed** in `lib/donor-names.js` (rescan parsed the list per NAME — ~1 s per list save at the validator's ceiling on the shared synchronous connection; a separators-only label was stored and shown as the name `-`), `test-donor-names.js` 148 → 156/156; three docs corrections (this section's heading + header said "NOT built" / "Parts 3–6 design only" while §16.11 said Parts 1–4 done; the security audit named only Part 1). All 16 suites green after the fixes. Nothing here has run on a VPS |
| 6 | VPS acceptance on testnet with live miners | **superseded 2026-09-23** — never run; replaced by §18.10 Part 7, which tests the v2 behaviour instead |

### 16.12 Implementation deltas + the Part 5 review (2026-09-21)

What the four build sessions changed against §16.1–§16.10 (each was recorded in §16.11 / impl
§10.3 as it happened; collected here so the design reads true), then what the independent
review found. Nothing below has been VPS-tested.

**Deltas — what shipped differs from the section above in these ways, and why:**

| § | As designed | As built | Why |
|---|---|---|---|
| 16.2 | worker part "lowercased" | ASCII `A-Z` only, folded BEFORE the charset regex | `toLowerCase()` maps U+212A KELVIN SIGN into the charset as `k`; a byte outside `[a-z0-9_-]` must keep failing, not be adopted |
| 16.4 #2 | pool name always reserved | reserved only when it normalises to **≥ 3 chars** | a one- or two-letter pool name would censor nearly every donor |
| 16.4 | `''` clears `donor_name` | `''` clears the name **and an `auto` verdict**; `admin` / `allow` survive | the auto verdict was about the name that is gone; the two admin states are per-ADDRESS decisions |
| 16.4 (review) | any label inside the grammar is a name | a label with **no letter or digit** (`--donate10` → `-`) is **no label** — same as `''` | it normalises to nothing, matches nothing, and headed a card as the name `-` |
| 16.7 #12 | expiry = 12 months after the **last donation** | 12 **calendar** months (UTC) after the **later of** the last debit and the capture; **censor outranks expiry** | a name just re-set through the ceremony must not read "expired" while its first debit is a block away; an aged-out censored name is still the operator's decision |
| 16.5 #2 | rescan on list save | rescan on list save **or pool rename**; the list is parsed **once per walk** (review) | the pool name is a reserved word, so renaming the pool changes verdicts; per-name parsing cost ~1 s per save at 4000 entries × 300 names |
| 16.5 #3 / 16.8 | table = addresses with a debit **or** a live tag | also addresses with a **stored name** and neither; un-censor from NULL and censor of a nameless address both allowed (pre-emptive, sticky) | a donor who ran the ceremony then paused has a name on file and no debit — moderation that starts after the first debit publishes it is the review gate #3 rejected |
| 16.6 | "day-aligned for rolled days" | stated exactly: a rolled day is **in WHOLE** when its UTC midnight ≥ `now − W`, else out whole; raw rows at second precision | the cutoff lands on a day edge for anything older than the rollup horizon — say so once, in the lib |
| 16.6 | `past` ORDER BY `last_donated_at DESC` | ties broken on lifetime DESC, then address ASC | rolled days tie by the day; an unordered tie shuffles the strip on every poll |
| 16.6 | league LIMIT 100 | a donor past the 100th league place is counted in `totals` and shown on **neither** list | design as written; now stated |
| 16.6 | `active_donors` "counts live tags" | `COUNT(*)` of `miner_incentives.donation_percent > 0`, 0 while donations are off | one COUNT, not a filter over the cards; the same `donationsActive()` gate as every other "current" reading |
| 16.8 | settings form "harvester, ids = keys" | the form is **page-local** (same three harvester rules), not `settings-common.js` | `saveSection()` discards the response body, and the one thing this form must show is the rescan counts; `updateSection()` upserts only the keys it is sent, so no merge step was needed |
| 16.8 | "Dashboard + nav show N new names" | dashboard tile from `/api/admin/dashboard new_donor_names_7d`; the nav badge from a one-COUNT `GET /api/admin/donors/summary` | the dashboard route runs a dozen queries; a badge painted on every page load must not |
| 16.8 | workers "tagged rig marked" | `parseDonateToken()` exported from `lib/stratum-protocol.js` (the login regex became a named constant both use) | one grammar, not a second copy drifting from the login |
| 16.9 | donation row shows a name | the row stays visible for a **paused** donor who has a name (`paused (0%)` + the name line) | a paused donor keeps their name; hiding the row would hide the one place they can read it |
| 16.10 | mask the address | `donorWall()` **throws** without a mask function and applies it to both arrays inside the lib | `past` is exactly the second array a route would forget (§J11-1) |
| — | — | `scripts/check-syntax.js` sniffed `type=` over the whole `<script>` MATCH, body included, so any page whose row template contains `type="button"` was never syntax-checked | found while adding `donors.html`; fixed to the opening tag only (29 → 32 inline blocks) |

**Part 5 review — nine questions, read cold against the diff (answers verified against the code,
not the notes):**

1. **Stranger write.** `captureDonorName` has ONE call site: `_applyParkedDonation` → `wrote && current === 0 && percent > 0`. A LOWER, a same-% reconnect, `donate0`, a refused raise, and a set `setDonation` refused (donations off, reserved address) never reach it; a banned address is refused at login before a session exists. A stranger at `donate1` against a PAUSED donor does reach it — by design (#2, §16.10): the name is replaced (or cleared by a plain tag), an `auto` verdict goes with it, `admin`/`allow` survive, and the victim's account page shows the new name / "hidden by the pool". Confirmed as designed.
2. **Leakage.** Public responses touching `miner_incentives`: `/api/account/:addr` (emits `donor_name` + `donor_name_state`, selects three columns) and `/api/pool/donors` (via `donorWall`; no card key starts with `donor_`, `donor_censor` is read for `displayState` and never emitted). `GET /api/admin/miners/:addr` returns the whole row (`SELECT *`) but is `secureAdmin`. The marker string leaves only when `censored_display` is `marker`. Nothing else.
3. **Censor state table** (current → capture(name) / capture('') / rescan / censor / uncensor): NULL → auto-or-NULL / NULL / auto-or-NULL / admin / allow · auto → re-matched / NULL (word, at, by cleared) / auto-or-cleared / admin / allow · admin → admin (name + set_at updated) / NULL, admin kept / skipped / 409 / allow · allow → allow / NULL, allow kept / skipped / admin / 409. Matches §16.4/§16.5 plus the deltas above.
4. **Ranking.** One card hand-recomputed from a stub DB (rolled 1.0 + rolled 2.0 + raw 0.5, three distinct months: `3.5 × 1.3 = 4.55`; a second donor `0.25 × 1.2 = 0.3`); the rolled day at `now − 365 d` (midnight < a noon cutoff) is OUT and the next day IN, as stated; ties by months then first donation; `slice()` in JS, no `LIMIT -1`; blank / `"abc"` / `NaN` / `"Infinity"` / `0` cap / `1e9` months all resolve to the documented defaults through `donorSettings()`, and a raw section passed by mistake still gives a finite score.
5. **Type traps.** Every reader of the six keys goes through `donorSettings()` (bounded ints, 0–100 percent, cap ≥ 1, closed enum) except the rescan hook, which reads the list text and hands it to `rescanAll` → `parseList` (split on newlines, trimmed, never a `RegExp`; the only `new RegExp` in the lib is built from the `MAX_WORKER_NAME_LEN` constant). Write-side validators mirror the bounds. No new booleans.
6. **DB cost** (EXPLAIN QUERY PLAN, no ANALYZE — as the capacity memory prescribes): `donorLedger` = the same two `SEARCH`es the old wall query ran plus a temp b-tree for `COUNT(DISTINCT)` over donation rows only; `lastDonatedAt` = two indexed `SEARCH`es; the three `miner_incentives` reads are scans of a table with one row per address; the admin list's per-row `getWorkersForAccount(addr, 1440)` is a `SEARCH shares USING INDEX idx_share_address` + a per-address temp b-tree — bounded by that address's ≤ 31 h of shares, up to 500 rows per page load, polled every 60 s per open admin tab. **First per-row shares read in the panel**; cheaper than one table-wide 24 h scan while donors ≪ miners. The one real cost found was the rescan (finding A below).
7. **Admin panel.** `.error-msg`/`.success-msg` carry no `display:none` (inline `style` hides them); the nav pill's ink is `var(--btn-text)`, the admin bundle's ink-on-accent token; the page uses `API.get` (= `Auth.fetch`) for reads and `adminFetch` (step-up aware, in-page dialog — `confirm()` then `adminFetch` is one native dialog, not a chain) for every write; the two moved keys exist on exactly one page, and `updateSection()` upserts partial key sets so the Incentives page and this one cannot clobber each other; both POSTs are `freshAdmin` and `adminCensor()` writes its `admin_audit_log` row in the same transaction; the settings save is audited by `updateSection`.
8. **Public page.** Every name passes `escHtml` (`nameCell` serves both the grid and the past strip); "(all times UTC)" is stated once in the deck-head; the 390 px iframe probe was run by Part 4 on three fixtures (0 elements past the right edge) and not re-run here; empty league + non-empty past, tags-set-but-no-debit, and unavailable each have their own copy; the `API_DOC_META` row lists the 14 card keys and the four top-level ones exactly as `donorWall()` emits them, with the notes (opt-in lowercase ≤ 32, masked, marker only under `marker`, totals lifetime over every donor, window edge) hand-read against the builder.
9. **Docs.** §16.11's counts matched a fresh run of every suite (guards 71, names 148 → 156 after the fixes, league 68, leakage 77, admin-panel 71, admin-guards 79). Three honesty defects, fixed: this section's heading and the file header still said "NOT built" / "Parts 3–6 are design only" / "Parts 1–2 done" while §16.11 said Parts 1–4 done; the security audit's freshness header named only Part 1 although Parts 2–4 added a public text surface, two admin write routes, six settings and a rescan hook (none of which has had a §J-style pass — this review is the only one so far, and its header now says so). No session scaffolding in `docs/generated/`.

**Findings (both fixed, `lib/donor-names.js`):**

- **A · Medium (efficiency on the shared connection).** `rescanAll` called `matchBlocklist` per row, and `matchBlocklist` re-parsed the whole list text (normalising every entry) on every call. Measured: 300 stored names × the validator's 4000-entry ceiling = **1048 ms** per list save, on the synchronous connection StratumServer shares — a one-second stall of share intake, admin-triggered (not an amplification vector). Fixed by splitting the matcher (`matchEntries(name, entries, poolEntry)` under `matchBlocklist`) and parsing once per walk: **16 ms**. Pinned by an equivalence test, a source check that `parseList` is called once above the loop, and a 2 s ceiling.
- **B · Low (cosmetic, but a name-shaped non-name on a public page).** A worker label made only of separators is inside the grammar — `--donate10` hands `validateUsername`'s `donor_label` over as `-`, `_-_-donate10` as `_-_` — passed `LABEL_RE`, normalised to `''`, matched nothing, and was stored and SHOWN as the donor name `-`. Now treated as no label at capture (clears, like `''`); one real character (`-a-`, or a lone leet digit `0`) is still a name.

**Known properties, not findings (stated so the next reader does not re-derive them):** an
`allow` override is exactly that — a donor un-censored for a false positive can rename to
anything and it shows until an admin acts; the NEW badge (7 d) and the dashboard tile are the
signal, there is no "renamed while allowed" state. A stranger's rig mining to a donor's address
appears in that donor's admin `workers` cell (with the tag mark if tagged) — §J6-9 already
accepted this for sessions with an accepted share, and here it is what lets the operator SEE a
stranger write. Donation ledger rows are counted as debits only, as the wall always did; an orphan
reversal has never touched donation rows (out of §16's scope). `parseInt` quirks (`"1e3"` → 1)
apply to every `intRange` setting on the panel and are the same on the write side, so a stored
value never disagrees with its read.

---

## 17. Ownership-proof SET — 10 per kind, per-address salt (2026-09-22 — Parts 1–3 BUILT, Part 4 reviewed 2026-09-23, nothing VPS-tested)

Replaces the **2-slot proof window** (`last_ip`/`prev_ip`, `last_pass_hash`/`prev_pass_hash`)
that has gated every self-service money action since 2026-07-17 (impl §10; audit §E, §F, §J3).
Built in five sessions — backend → account page → copy sweep + docs → independent review → VPS
acceptance — with the run order kept outside the repo. §17.6 carries each part's state: **Parts 1
(the backend), 2 (the account page) and 3 (the copy sweep) are built, and the independent review
(Part 4) has run** — it fixed three defects, and §17.7 records them against this contract.
Already-installed pools still show the old window in their CMS pages until the
operator edits them (§17.6, Part 3 delta 3). Nothing in this section has run on a VPS.

### 17.1 Why the 2-slot window is wrong, not merely small

- `recordOwnerEvidence` compares a capture against **`last_ip` only** (owner-proof.js, the
  `matchesStoredIp(ip, row.last_ip)` test). Two facilities A/B whose rigs reconnect in turn
  rotate the window on **every** reconnect: `last=b,prev=a` → `last=a,prev=b` → …. Each
  rotation (1) re-stamps `last_ip_at = now`, so the §J3-1 AND+AGE gate reads a freshly-reset
  age and refuses the owner's own destination change (`proof_too_recent`) whenever their rigs
  reconnected inside the last hour; (2) writes an `evidence_displaced` audit row and lights the
  account page's **"Evidence changed"** warning for seven days — for honest churn. With three
  or more sites every reconnect evicts one site's proof.
- The page's "use the **same** password on every rig" was therefore a workaround for the slot
  count, not a security property. **Operator decision 2026-09-22:** it becomes a convenience
  tip; different passwords per site all work; the window becomes a set of ten.

### 17.2 Decisions (all FINAL unless a build finds a hard reason)

1. **Storage is a SET per (address, kind)** in a new table `miner_proofs` (§17.3). Cap
   **`PROOF_SET_MAX = 10` live rows per kind**, a hardcoded constant in `lib/owner-proof.js` —
   not an admin setting: the only reason to keep it small was scrypt cost, and #3 removes that.
2. **Eviction is least-recently-SEEN** (`last_seen_at`), never FIFO. A known value seen again
   refreshes `last_seen_at`; **`first_seen_at` never moves** and is what the age gate reads.
   *(Part 4, §17.7 #3: never moves on a LIVE row — an evicted anchor returning restarts it.)*
3. **One salt per address.** `miner_accounts.proof_salt` (16 random bytes, base64, minted on the
   address's first v2 hash with `UPDATE … WHERE proof_salt IS NULL` then re-read, so two rigs'
   first shares landing together share one salt). Rows store `v2$<hashB64>`; scrypt parameters
   unchanged (N=16384, r=8, p=1, keylen 32, 16 MB). **One scrypt per verify and per capture
   regardless of set size** *(Part 4, §17.7 #5: two for a non-canonical, password-shaped IP)*; digests compared with `crypto.timingSafeEqual`. Legacy
   `v1$salt$hash` rows are copied as-is and cost one scrypt each until evicted; a capture that
   MATCHES a v1 row (the plaintext is in hand at that moment) rewrites it in place as v2.
4. **Anchor unchanged in meaning** (§J3-4): the address's first-ever value of each kind, flagged
   `is_anchor=1` on its own row. Never deleted — when it is the LRU row of a full set it is
   marked `evicted_at` instead of removed. `verifyOwnerProof` reports `slot='anchor'` **only for
   an evicted anchor row**; a live anchor is an ordinary member (today a window hit already
   wins the label). `requireBothProofs` in index.js keeps refusing `slot='anchor'` and any leg
   younger than `MIN_PROOF_AGE_SEC` — its code does not change.
5. **Capture rule** (`mayDisplace` keeps its §J3-4 meaning): refreshing a known live value is
   always allowed; INSERT into an **empty** set is allowed on the first accepted share and that
   row becomes the anchor; INSERT into a **non-empty** set — including re-activating an evicted
   anchor — needs `mayDisplace` (`PROOF_MIN_SHARES = 4`, unchanged). A full set evicts LRU live
   rows until the count is below the cap (evict `count − max + 1`, so a concurrent double-insert
   self-corrects on the next capture instead of growing).
6. **Audit:** `evidence_added` (`kind`, live count after, `evicted` yes/no) on every insert into
   a non-empty set — that is the hostile signature. No row on refresh. `evidence_displaced` is
   retired.
7. **Public account summary** gains `proofs: { ip, pass, max, anchor, last_added_at }` — live
   counts, the cap, whether an anchor row exists, and the newest `first_seen_at` across both
   kinds. Never a value, a hash, a salt, or per-row timestamps. `has_recorded_ip` /
   `has_recorded_pass` stay (derived from the counts). The `evidence` object is removed. The
   admin miner view gets per-kind `{ live, oldest_first_seen, newest_last_seen, anchor_live }`,
   no hashes (§J8-2 stays satisfied).
8. **Account page:** no warning banner. The on-record hint states the counts and the last-added
   time; the "someone else mined to this address" explanation moves into the collapsed *Why
   does my rig password matter?* fold. Password diagnostics keep every reject-reason state;
   **"Mismatch" only when live distinct passwords exceed `max`**; two or more distinct passwords
   within the cap is an OK line. The "same password on every rig" sentences become a tip.
   *(Reversed 2026-09-23 at the operator's request, "less text": the fold is removed. The
   "someone else mined to this address" and "it can't be used to steal your coins" reasoning is
   now an HTML comment above the P-04 gate label, and the account page has no visible home for it.
   The password rules link to the homepage setup guide. Impl §10.5 Part 3 lists where each fact
   went.)*
9. **Legacy columns** (`last_ip`, `prev_ip`, `last_pass_hash`, `prev_pass_hash`, the four `*_at`,
   `anchor_ip`, `anchor_pass_hash`, `anchor_set_at`) are copied into the set by ONE synchronous
   `migrateProofSet(db)` that runs where `backfillProofAnchors` ran — ahead of the stratum
   listener, for the same reason *(Part 4, §17.7 #1: "where the backfill ran" was AFTER the
   listener; it now runs immediately before `stratumServer.start()`)* — and are then **NULLed; the NULL is the idempotency proof**
   (repo style: no marker table; `migrateOwnerProofHashes` + `backfillProofAnchors` are deleted,
   their jobs subsumed). Columns stay in the schema — never `DROP COLUMN`. Mapping: the anchor
   value becomes a row with `is_anchor=1`; if it equals `last` or `prev` that is the same row and
   it is live; otherwise `evicted_at = anchor_set_at` (it was already outside the window). `last`
   and `prev` become live rows with `first_seen_at = last_*_at` / `prev_*_at` (NULL = unknown =
   old, the existing rule). A pre-v1 plaintext value is hashed to v2 with `scryptSync` during the
   copy — bounded, one-time, and no VPS has ever held one.
10. **Not touched:** `PROOF_MIN_SHARES`, the (address, origin) lockout and its counters, the
    AND+AGE gate, `pass_proof_state`, `getPasswordConsistency`, the `withdraw`/`export` rate
    buckets, `verifyOwnerProof`'s signature and return keys (`ok, reason, method, slot,
    age_seconds` — `slot` is now `'set' | 'anchor'`).

### 17.3 Data model

```sql
CREATE TABLE IF NOT EXISTS miner_proofs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  grin_address  TEXT    NOT NULL,
  kind          TEXT    NOT NULL CHECK (kind IN ('ip','pass')),
  hash          TEXT    NOT NULL,                 -- 'v2$<b64>' (per-address salt) or legacy 'v1$<salt>$<b64>'
  first_seen_at INTEGER DEFAULT NULL,             -- never updated on a live row (a returning anchor restarts it, §17.7); NULL = migrated without a timestamp = old
  last_seen_at  INTEGER NOT NULL,                 -- refreshed on every matching capture; the LRU key
  is_anchor     INTEGER NOT NULL DEFAULT 0,       -- first-ever value of this kind; never deleted
  evicted_at    INTEGER DEFAULT NULL,             -- NULL = live. Only an anchor row can be non-live
  UNIQUE (grin_address, kind, hash)
);
CREATE INDEX IF NOT EXISTS idx_miner_proofs_lru ON miner_proofs (grin_address, kind, evicted_at, last_seen_at);
-- miner_accounts: + proof_salt TEXT DEFAULT NULL (same add-column-if-missing helper as the other 2026 columns)
```

"Live" = `evicted_at IS NULL`. Counts, the cap and the LRU pick all range over live rows only.
A non-anchor row that is evicted is deleted, not flagged.

### 17.4 Threat notes for the review pass

- **Grief ceiling unchanged.** A stranger's proof still lets them trigger a payout to the
  OWNER's wallet (Tor pays the address's onion, a slatepack is encrypted to it) — the accepted
  residue from §E. What changes is that their entry now sits *beside* the owner's instead of
  pushing it out.
- **Evicting an owner's value** now requires out-churning every live owner rig: LRU keeps
  whatever is most recently seen and the owner's rigs keep refreshing. The departed miner is
  covered by the anchor exactly as before.
- **Per-address salt vs per-row salt:** an offline attacker with the DB precomputes scrypt once
  per address instead of once per row — at most a ×10 saving on a 2^32 × 16 MB job, and the
  work still cannot be shared across addresses. Same order, accepted.
- **The CPU lever (§F2 math) holds:** a failed verify costs 1 scrypt + n_v1, where n_v1 ≤ 3 for a
  migrated account and 0 once its v1 rows are upgraded or evicted. Today it is 2–3.
  *(Part 4 measured this as under-stated on both terms — 1–2 v2 digests, and n_v1 counts both
  kinds, so ≤ 6: a transitional ceiling of **8**, above the window's 6. Still bounded by
  FAIL_MAX_IP; see §17.7 #5.)*
- **First capture into an empty set is still cheap**, so an address's anchor is whoever mines
  to it first. Unchanged from §J3-4; the AND+AGE gate is what keeps that from redirecting money.
- **Keying trap (§J3 self-review):** every per-connection question must read
  `session.acceptedShares`, never `shareCount` — the latter counts the whole address.
- **Nothing that reaches a browser may carry a hash or the salt**: `test-public-leakage.js`
  must assert the shape of `proofs` and the absence of `proof_salt`.

### 17.5 Copy that states the old window (must all change)

`public_html/account-settings.html` (P-04 gate block, `PASS_STATE_TEXT`, `renderPasswordProof`,
the fold), `public_html/index.html` (setup guide), `back-end-pool/lib/pool-settings.js` (shipped
CMS defaults — privacy page + FAQ; seeds only, an installed pool keeps its edited pages),
`index.js` `API_DOC_META` for `GET /api/account/:addr`, `admin-panel/users.html`,
`lib/miners.js` + `lib/stratum-server.js` comments, and the prose in audit §E/§F/§J3 (which
describes what WAS — add a pointer to this section rather than rewriting findings).

### 17.6 Status
| Part | Scope | State |
|---|---|---|
| 1 | Backend: `miner_proofs`, per-address salt, set capture/verify, migration, account + admin API, tests | **done 2026-09-22, NOT VPS-tested** |
| 2 | Account page P-04: counts hint, fold text, password diagnostics, demo dataset | **done 2026-09-22, NOT VPS-tested** |
| 3 | Copy sweep (§17.5), docs fold, memory | **done 2026-09-23, NOT VPS-tested** |
| 4 | Independent review of 1–3 against this section + §17.4 | **done 2026-09-23** — 3 code defects fixed, 2 docs corrections, suite 875 → 881; §17.7 |
| 5 | VPS acceptance — **MAINNET**, not testnet (operator decision 2026-09-23): the migration is a one-way door over real balances, `/inject` is testnet-only so a payout test needs a matured real credit (confirm_depth 1440), and every rig is a paying customer. Dry-run the migration on a DB copy first; the go/no-go is "accounts with a balance and no proof row" matching its pre-upgrade baseline | not started |

**Part 3 as built (2026-09-23)** → `script07_implementation.md` §10.4, "Part 3". Copy and comments
only — no logic changed, suite unchanged at **875/875**. Surfaces corrected: the homepage setup
guide's PIN line (`public_html/index.html`), the shipped Terms, Privacy and FAQ defaults in
`lib/pool-settings.js` (four passages, and each page's *Last updated* moved to September 2026), the
`requireBothProofs` comment and the `nostr-destination` `API_DOC_META` row in `index.js`, three
`lib/stratum-server.js` comments, one in `lib/owner-proof.js`, the legacy-column comment in
`lib/db.js`, and pointer notes in audit §J3 and its Status roll-up (findings left as written).
Deltas:
1. **`admin-panel/users.html` needed nothing.** §17.5 lists it, but it states no proof window —
   its "window" is the audit-log time range.
2. **One user-facing error string changed**: the 409 `anchor_not_accepted_here` text claimed "that
   proof is your original recorded one", which since Part 1 fires only for an EVICTED anchor. It now
   says the original has dropped out of the ten most recently used. Same branch, same code, same
   reason string.
3. **⚠ Installed pools do NOT get the new CMS text.** `lib/db.js` seeds the pages table once
   (`migratePagesFromConfig`, marker `pages_seeded`), and there is no restore-to-default control
   for pages — the `/restore` route resets `pool_config` sections, not `pages` rows. A pool that has
   ever started keeps its 2-slot Terms, Privacy and FAQ text until the operator edits those three
   pages by hand in Admin → Pages. Recorded for Part 4, not fixed (no behaviour change this part).

**Part 2 as built** → `script07_implementation.md` §10.4, "Part 2". §17.2 #8 was built as
specified. Three deltas, all additive:
1. **A third hint state** — live counts 0 but the write-once anchor alive. §17.2 #7 does not name
   it and the run plan said "both zero → first-run text", which would tell an account that can
   still reach its wallet that nothing is recorded. Reachable via the migration (an `anchor_*`
   with both window slots empty lands as one evicted row, no live row).
2. **`proofs` absent is its own branch** — an older backend or a cached response gets the old
   whether-not-how-many sentence, and the two cap-dependent password lines fail quiet. A count the
   server did not send is not a fact about the account, and "0 on record" would be a false alarm.
3. **The *Partial* line's advice changed** ("set the same password on every rig" → "set one on
   that rig too — it does not have to match the others"). The run plan said to leave that branch
   alone; §17.5 names `renderPasswordProof` as copy that must change, and Part 3's grep would not
   have found the sentence. Logic unchanged.

**Part 1 as built** → `script07_implementation.md` §10.4. Everything in §17.2 and §17.3 was built
as specified. Deltas, all additive and all recorded in §10.4:
1. **`test-public-leakage.js` got the §17.4 assertions** (the `proofs` shape, the absence of
   `proof_salt`, no digest in a log line). §17.4 asks for them; the run plan's Part-1 file list
   did not name the file. They are API-shape assertions, and Parts 2–3 do not touch it.
2. **`_makeRoom(db, rows, now, headroom)`** — 1 when a row is about to be inserted, 0 for the
   migration's defensive trim. Evicting `live − max + 1` when nothing is being inserted would
   discard a working proof for nothing.
3. **`is_anchor` is computed inside the INSERT** (`CASE WHEN EXISTS (… is_anchor = 1)`), not from
   a snapshot taken before the KDF. Two first captures racing through scrypt would otherwise each
   see an empty set and each claim the anchor. For the same reason `_captureProof` reads the rows
   twice — once to learn which v1 rows need testing, once after the last `await` — so nothing that
   decides (live count, cap, LRU pick) is read across an await from the write depending on it.
4. **`hashProof` (the v1 writer) is exported.** No production path writes v1 any more, but the
   regression suite must build a legacy row through the code that parses one.
5. **`freshDb()` in the test now uses `lib/sqlite-compat.js`**, the wrapper production uses. A bare
   `node:sqlite` `DatabaseSync` has no `.transaction()`, so the migration threw in the test and
   worked in production.

Measured, not assumed — a failed verify costs **1** scrypt on a v2-only set of any size, **1 + n_v1**
on a migrated account that has a salt, **n_v1** while it has none (§F2's throttle is sized on this;
the old window cost up to 6). *(Part 4: incomplete — see §17.7 #5 for the 2 and the 8.)* Suite:
**849 → 875 checks across 15 suites, all passing.**

**Part 1 ships alone.** `account-settings.html` still reads the removed `evidence` object but
guards it with `|| {}`, so it degrades to no warning and no crash until Part 2.

### 17.7 Implementation deltas + the Part 4 review (2026-09-23)

**What building changed against §17**, collected from §17.6: `_makeRoom`'s `headroom` argument;
`is_anchor` decided inside the INSERT; the double read in `_captureProof`; `hashProof` exported;
`freshDb()` on `sqlite-compat.js`; the leakage assertions (Part 1). A third hint state, a
`proofs`-absent branch, the *Partial* wording (Part 2). `users.html` untouched, the 409 text
reworded, the CMS seed-once gap (Part 3). All additive; none changed a §17.2 decision.

**The review** read the code cold, not the build reports. Each of the ten questions, answered
from the code (line numbers as of this review; impl §10.4 "Part 4" has the fix table):

| # | Question | Answer |
|---|---|---|
| 1 | Can the live set exceed `PROOF_SET_MAX`? | **No.** `_captureProof` decides after its last `await` (re-read → `_makeRoom` → insert, all synchronous); the migration trims with `headroom 0`; a re-activated anchor goes through the same `_makeRoom`. But the race found **#2** below: a set could drop to 9 for no reason. |
| 2 | Can an anchor row be DELETED? | **No.** The only `DELETE FROM miner_proofs` is behind `if (r.is_anchor) … else` in `_makeRoom`; no `OR REPLACE` exists anywhere in the backend; `_upgradeV1Row`'s UNIQUE conflict is caught (ABORT, not REPLACE); nothing deletes a `miner_accounts` row. |
| 3 | Does `first_seen_at` move? | **Not on a refresh** (only `last_seen_at` is written). But it failed the question the other way: a returning EVICTED anchor kept its old stamp, which is worse — **#3**. It now restarts, the only write that moves it, and only forward. |
| 4 | Scrypt calls on a FAILED verify | (a) fresh account, no rows: **0** (`no_recorded_proof` before any KDF); with v2 rows: **1**, or **2** for a non-canonical, password-shaped IP (`2001:db8::1`). (b) migrated, three v1 rows of one kind, salted: **4**; no salt yet: **3**; with anchor/last/prev of BOTH kinds and a salt: **8**. §17.4's "1 + n_v1, n_v1 ≤ 3" was low on both terms — **#5**. |
| 5 | Hash / salt / raw value in any output? | **No.** Account view: counts + `last_added_at` (the newest live `first_seen_at` — one row's timestamp, but §17.2 #7 specifies it). Admin view: explicit column list, per-kind aggregates. Audit: `{kind, live_after, evicted}` + coarsened IP + country. `console.*` in `owner-proof.js`: address + reason code or `e.message` only. |
| 6 | Is the migration idempotent, and ahead of the listener? | **Idempotent: yes** (NULLs what it copied; asserted). **Ahead of the listener: NO** — it ran ~130 lines after `stratumServer.start()`, behind `await nostrBridge.start()`, and the §J3 backfill had the same placement since 2026-08-26 — **#1**. Fixed and locked by a source-order check. |
| 7 | Anything keyed on `shareCount`? | **No.** Both guards (`stratum-server.js` donation + capture) and both readers (`miners.js getPasswordConsistency`, `index.js` donors rigs-online) read `acceptedShares`; `shareCount` survives only as a display field. |
| 8 | Tests that drive helpers while production does something else | Three: the cadence (`acceptedShares === 1 \|\| >= 4`) lives in `stratum-server.js` and is never executed by a test — the tests pass `mayDisplace` directly; `destinationLegOk` is a REPLICA of `requireBothProofs` (in step today, and it does not cover the "password in both fields" `method` check); and the migration check that claimed to cover anchor == last used data where they differed, so the common upgrade case was untested (it works; now covered). The "concurrent first captures" check does exercise the re-read — it would fail against the pre-KDF-snapshot draft. |
| 9 | Page vs a backend with no `proofs` | **Degrades correctly.** `proofHintText` falls back to the booleans; `renderPasswordProof` treats `max 0` as "unknown" and drops both cap-dependent verdicts. |
| 10 | Is the grief ceiling still "a payout to the OWNER's wallet"? | **Yes, with #3 fixed.** Withdraw (Tor/slatepack/nostr-to-registered) takes one proof, anchor allowed; destination register takes both legs via `requireBothProofs`, which refuses `slot 'anchor'` and any leg under `max(1 h, cooldown)`. Before #3 a re-activated anchor passed as an aged IP leg — still not theft (the password leg is aged and owner-only), but a hole in the §J3-4 rule. |

**Fixed:**
1. **Startup order** — `migrateProofSet(db)` moved before `stratumServer.start()`. It matters most
   on exactly the pool Part 5 upgrades first: MAINNET, where Nostr payouts may be on.
2. **Duplicate-capture race** — `_captureProof` re-locates its match by its own v2 digest too.
   Needs a v1 row's await window, i.e. a migrated account; the trigger is ordinary (rigs behind one
   NAT reaching `PROOF_MIN_SHARES` together). Reproduced 2 rows lost, fixed to 1.
3. **Returning anchor restarts its age** — `first_seen_at = now` on re-activation. **This amends
   §17.2 #2** ("`first_seen_at` never moves" → never on a LIVE row). The honest-owner cost is one
   cooldown on that one leg, for a miner with more than ten sites whose original returns; their
   other live proofs keep their ages.
4. **`proof_too_recent` text** prints the enforced floor, not `cooldownH` (a 0 cooldown said
   "0 h"); the anchor text interpolates `PROOF_SET_MAX`.
5. **KDF cost statements corrected** (§17.4, impl §10.4, the `verifyOwnerProof` comment) and both
   uncounted cases asserted. Not changed in behaviour: 8 per failed guess while v1 rows survive is
   bounded by `FAIL_MAX_IP = 20` per 10 min (160 KDFs per origin, vs 120 under the window), is
   transitional, and removing it would mean refusing to try an IP-shaped value as a password.

**Decided, not changed:** CMS re-seed stays an operator note (operator-owned legal text; the stale
wording under-states the product, it does not endanger anyone). The Part 3 409 text is accurate.

**Open for Part 5:** the account page says a new password is "on record" at share 1, but on an
address that already has proofs it is inserted at share 4 (`PROOF_MIN_SHARES`). Reword only if
Part 5 measures share 4 taking hours rather than minutes.

Suite **875 → 881** (`test-owner-gate.js` 36 → 42). Each new regression check failed against the
pre-review code before the fix.

---

## 18. Donations v2 — per-share donation + reviewed donor profiles (DESIGN 2026-09-23; Parts 1–5 BUILT + Part 6 REVIEWED 2026-09-24, NOT VPS-tested)

Operator review of §16 on 2026-09-23, before its VPS acceptance ran. Three findings, all about
what a miner *believes* the tag does versus what the code does:

1. **The tag was per ADDRESS, not per rig.** `rig01-donate10` stored 10 % against the whole
   address (`miner_incentives.donation_percent`) and `applyToDistribution` took it from **every**
   rig's earnings. A miner with five rigs and one tag donated from all five, and the wall's
   "N rigs online" read as if only the tagged one gave.
2. **Removing the tag did not stop it.** A plain `rig01` login left the stored % untouched; only
   `donate0` cleared it. Two rigs with different tags resolved by connection order.
3. **The raise ceremony read as a bug.** "`donate0`, a few shares, then `donate20`" is a security
   rule (§J6-7: login is unauthenticated, so a stored % must never be raisable by a stranger),
   but to a miner whose software restarts and re-sends the name anyway it looks pointless.

And one product finding: a brand name typed into a worker label (`yourbrand-donate10`) is a poor
channel — 32 lowercase characters, no logo, set through the ceremony, and anyone mining to a paused
address could overwrite it (§16.10 accepted that). This section replaces both mechanisms. **§16 stays
as the record of v1**; where they disagree, §18 wins. The per-session build prompts are kept
outside the repo (plans dir), as for §16/§17.

> **Since §19.17.6 (games v2 Part C4, 2026-10-04) donor NAMES are no longer reviewed:** they are checked
> automatically (the shared name rule, donor shape) and live at once; banners stay pre-moderated. Where this
> section says a name waits for review, is flagged, or uses `donor_name_blocklist`, §19.15 *Part C4* is the
> current text (pointer in §18.11).

### 18.1 Decisions (operator, 2026-09-23 — FINAL unless a build finds a hard reason)

| # | Decision | Replaces |
|---|---|---|
| 1 | **Donation is per SHARE.** A share whose worker name carries a live `donateN` token (0–100) donates N % of the PPLNS credit *that share* earns. Nothing is stored per address. | §16.4's stored % + §J6-7's lower-only rule |
| 2 | **No ceremony.** Rename the rig (`rig01-donate20`, or plain `rig01`) and restart the miner — it applies from that rig's next share. `donate0` is now just "a tag of 0 %", equal to no tag. | §16.9's raise/rename ceremony |
| 3 | The worker label is **only a rig name** again. Recommended form `rig01-donate10`; the label in front of the token is no longer captured as a donor name. | §16.1 #1, §16.2's `donor_label`, §16.4 |
| 4 | **Donor profile** = a **nickname** (every donor) + a **banner image** (shown only for the top N of the league, default **5**). Set by the donor on the **account page**, not by worker name and not by email. | §16.1 #1, #13 |
| 5 | Profile writes are gated like a payout-destination change: **both proofs** (mining IP **and** rig password), each **aged** past the same floor (`requireBothProofs`, §J3-1) — plus the address must have **≥ 1 donation debit** (cost to post). | — (new surface) |
| 6 | **Everything is pre-moderated.** A submitted name or banner is invisible to the public until an admin approves it. The word list becomes **flag words** shown in the review queue, not an auto-censor. | §16.1 #3 (post-moderation), #4, #5, #6; §16.5 |
| 7 | Banner formats **PNG, JPEG, GIF** only (animated GIF allowed) — sniffed from the bytes; **SVG and WEBP refused**. | — |
| 8 | Card and account wording state **how many rigs** donate: *"since 2026-09-21 · 2 rigs donating"*, *"Donating to the prize pool: 10 % of new earnings from 2 of 5 rigs"*. | §16.7 `donating 10 %` / `rigs online` |
| 9 | Ranking (§16.6 score, window, loyalty, past strip) and name **expiry** (§16.7 #12) are **unchanged**; expiry now hides an *approved* profile, banner included. | — |

### 18.2 Money path (`lib/rewards.js` → `lib/incentives.js applyToDistribution`)

For a block with PPLNS shares `S`, miner reward `R`, `T = Σ diff`:

```
gross[a]   = Σ_{s ∈ S, s.addr = a}  R × diff_s / T                       (unchanged)
donated[a] = Σ_{s ∈ S, s.addr = a}  R × diff_s / T × pct(s) / 100
pct(s)     = parseDonateToken(s.worker_name)?.percent ?? 0               (lib/stratum-protocol.js)
```

- `shares.worker_name` is already written on every share (post-cut label, token kept — §16.2),
  so no schema change. `rewards.js` builds a `donateMap` beside `minerMap` and passes it to
  `applyToDistribution(blockHeight, minerMap, poolFee, donateMap)`; the donation leg reads
  `donateMap.get(address)` instead of `donationPercent(address)`. Clamp `min(donated, gross)`
  against float drift; skip `RESERVED_ADDRESSES`; only when `incentives_enabled` **and**
  `allow_miner_donations` (a tag on a pool with donations off donates nothing, as today).
- Ledger shape **unchanged**: one `debit/donation` row per address per block, one `credit/donation`
  to `prize_pool`. So `donor-ledger.js`, the prize-pool statement, `reconciliation.js` and the
  rollup need no change — verify, don't assume.
- **Removed:** `IncentivesManager.setDonation` / `donationPercent`, `stratum-server`'s parked
  donation (`session.donationPercent`, `_applyParkedDonation`, the `PROOF_MIN_SHARES` donation
  branch), `_captureDonorName`, `validateUsername`'s `donor_label`, `miners.js donationPercent`.
  `validateUsername` keeps returning `donation_percent` (the login log line and the tag grammar
  tests use it). The `miner_incentives.donation_percent` column and the six v1 `donor_*` columns
  stay in the schema, **unread** — dropping them is a later cleanup, not part of this build.
- **Upgrade effect** (say it in the release note): a v1 address-wide % stops at deploy. A miner who
  tagged one of five rigs now donates from that one only; a miner who removed a tag but never sent
  `donate0` stops donating. Tagged shares already in the PPLNS window still donate — the window is
  ~60 blocks, so for about an hour after a rename a found block can still take the old tag's cut.

### 18.3 Live readings — one helper, three surfaces

`liveDonations(sessions)` (pure, `lib/donor-ledger.js`) over **mining** sessions only
(`acceptedShares > 0`, §J6-9) → `Map<address, { rigs_online, rigs_donating, pct_min, pct_max,
donating_workers[] }>`. Distinct worker names, as the wall's `rigs_online` already counts.
Consumers, all gated on `donationsActive()` (off ⇒ zeros, as today):

| Surface | Reads |
|---|---|
| `/api/account/:addr` | `donation: { rigs_donating, rigs_online, pct_min, pct_max, workers }`; `donation_percent` kept = `pct_max` until the page switches (Part 5), then dropped |
| `/api/account/:addr/workers` | per worker `donate_percent` (from its name; null = untagged) |
| `/api/pool/donors` | per card `rigs_donating`, `pct_min`, `pct_max`; `totals.active_donors` = addresses with `rigs_donating > 0`; `current_percent` kept = `pct_max` until Part 4, then dropped |
| admin `/api/admin/donors` | same three fields per row |

Copy rules: one % → "10 %"; mixed → "5–20 %"; `rigs_donating = 0` → "paused — no tagged rig
online". The wall card: *"since 2026-09-21 · 2 rigs donating"* and *"10 % of new earnings from 2
rigs"*. The account row: *"10 % of new earnings from 2 of 5 rigs online"* + the rig names.

### 18.4 Donor profile — data model

```sql
CREATE TABLE IF NOT EXISTS donor_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  grin_address TEXT NOT NULL REFERENCES miner_accounts(grin_address),
  kind         TEXT NOT NULL CHECK (kind IN ('name','banner')),
  status       TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','replaced','withdrawn','removed')),
  name         TEXT,                 -- kind=name: as typed after normalise (18.5)
  image        BLOB,                 -- kind=banner: the bytes while PENDING only; NULL after any decision
  file         TEXT,                 -- kind=banner: server filename once approved (uploads/donors/)
  mime TEXT, width INTEGER, height INTEGER, bytes INTEGER, sha256 TEXT,
  submitted_at INTEGER NOT NULL DEFAULT (unixepoch()),
  decided_at   INTEGER, decided_by INTEGER REFERENCES users(id),
  reason       TEXT                  -- reject/remove reason, ≤ 200 chars, SHOWN to the donor
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_donor_req_pending  ON donor_requests(grin_address, kind) WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS uq_donor_req_approved ON donor_requests(grin_address, kind) WHERE status = 'approved';
CREATE INDEX        IF NOT EXISTS idx_donor_req_status  ON donor_requests(status, submitted_at);

CREATE TABLE IF NOT EXISTS donor_blocks (
  grin_address TEXT PRIMARY KEY REFERENCES miner_accounts(grin_address),
  blocked_at INTEGER NOT NULL DEFAULT (unixepoch()), blocked_by INTEGER REFERENCES users(id), reason TEXT
);
```

- **Why a request log, not columns:** history and audit come free, the two partial unique indexes
  make "one live + one pending per kind" a database fact, and the v1 columns are left alone.
- **Why a BLOB for a pending banner:** a pending image must never be web-reachable, and a new
  on-disk directory would need a deploy-script exclude (the backend rsync `--delete`s the app dir)
  plus a backup entry. In `pool.db` it is backed up by the 089/pool backup for free and served only
  by an admin route. Bounded: ≤ one pending banner per address × 300 KB, NULLed on every decision.
- **State machine** (per address × kind): submit → `pending` (an existing pending → `replaced`,
  blob NULLed) · approve → `approved` (the previous approved → `replaced`, its file deleted) ·
  reject → `rejected` · donor withdraws → `withdrawn` · donor or admin removes the live one →
  `removed` (file deleted). Every transition is one transaction; admin transitions write their
  `admin_audit_log` row inside it (fail-closed, like `adminCensor` did).
- Approving a banner writes `uploads/donors/<16 random hex>.<ext>` (ext from the sniff, never the
  upload), `mkdir -p` on first use, path containment check, mode 0644. Served by nginx's existing
  `location /uploads/` (sandbox CSP + nosniff, already excluded from the rsync and in the backup) —
  **no deploy-script change**. Verify that claim in the build; don't assume it.

### 18.5 Validation

**Name** — trim, collapse internal whitespace to one space, then: 2–32 chars; charset
`A-Z a-z 0-9 space - _ . & '` (ASCII only: no homoglyphs, no RTL overrides); at least one letter
or digit. **Case is kept** (brands are cased). Dots are allowed (a donor may name a domain) —
links are never made clickable. Anything else → 400 with the rule in the message.

**Banner** — multer memory storage with `limits.fileSize = 300 KB` (the limit is what stops a large
body, not a check after buffering it), one file. Then:
1. Sniff PNG / JPEG / GIF from the bytes. **Do not call `detectImage` as-is** — it returns `svg`
   for an XML head; use the binary sniffers only and refuse everything else (SVG, WEBP included).
2. Parse dimensions from the header — PNG IHDR, GIF logical screen, JPEG first SOFn (skip
   APPn/other segments; SOF0–SOF15 except C4/C8/CC). A header that does not parse is a refusal.
3. Width 320–1600, height 80–400, aspect (w/h) 2:1 to 8:1. Recommended on every surface:
   **800 × 200 (4:1)**, "PNG, JPG or GIF (animation allowed), up to 300 KB".
4. Store sha256 + dims + mime; the client's filename and declared MIME are never used.

### 18.6 Routes

**Miner** (public, `rateLimiter.middleware('withdraw')`, every write through `requireBothProofs`
generalised with a purpose string so its errors stop saying "payout destination"; outcomes to
`auditOwnerProof` as `donor_profile_submit` / `_withdraw` / `_remove`):

| Route | Does |
|---|---|
| `POST /api/account/:addr/donor-profile/name` | `{ name, proof, password_proof }` → pending |
| `POST /api/account/:addr/donor-profile/banner` | multipart `file` + the two proofs → pending |
| `DELETE /api/account/:addr/donor-profile/:kind` | `{ which: 'pending'|'live', proofs }` → withdrawn / removed |

Refusals, each with its own reason code: donations off (503) · no donation debit yet
(`not_a_donor`, 409) · `blocked` (403) · the proof codes `requireBothProofs` already emits.

`GET /api/account/:addr` gains `donor_profile`: `{ eligible, blocked, name: { live, state,
pending_at, rejected: { reason, at } | null }, banner: { live_url, width, height, pending_at,
rejected, slot_rank, slots } }`. The **pending name text and pending image are never returned**
here — the account page is public to anyone holding the address. `state` = `shown` · `expired`
· `none`. `slot_rank` = the league rank, so the page can say "shows while you're in the top 5
(you're #8)".

**Admin** (`secureAdmin` reads, `freshAdmin` + audit writes):

| Route | Does |
|---|---|
| `GET /api/admin/donors/requests?status=pending` | the queue: address (full), kind, name, dims/bytes/mime, submitted_at, flags (below), the donor's rank/lifetime |
| `GET /api/admin/donors/requests/:id/image` | the pending or approved bytes; `Content-Type` = stored sniffed mime, `nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cache-Control: no-store` |
| `POST …/requests/:id/approve` · `…/reject {reason}` | transitions above |
| `POST /api/admin/donors/:addr/remove {kind, reason}` | removes a live item |
| `POST /api/admin/donors/:addr/block {reason}` · `/unblock` | submission block; blocking also withdraws that address's pending requests |
| `GET /api/admin/donors/summary` | pending count (the nav badge — replaces "new names this week") |

**Flags** on a queued name (hints, never automatic decisions): reserved word / pool name
(§16.4's `RESERVED` + pool-name rule), a flag-word hit (`donor_name_blocklist`, normalised
substring as today), and **"same as an approved donor"** (normalised equality with another
address's live name — impersonation between donors).
The admin page loads a pending image through `adminFetch` → blob → object URL (a plain `<img src>`
would not carry admin auth); check the admin CSP's `img-src` allows `blob:`. *(Superseded as
built: the premise is false and the queue uses a plain same-origin `src` — §18.11 Part 3 #1.)*

**Removed:** `POST /api/admin/donors/:addr/censor|uncensor`, the rescan-on-save hook,
`captureDonorName` / `rescanAll` / `adminCensor` / `countNewNames` / `CENSORED_MARKER` from
`lib/donor-names.js` (which keeps `normalise`, `parseList`, `matchEntries`, `RESERVED`,
`STARTER_BLOCKLIST`, `addMonthsUtc`, `donorSettings`).

**Settings:** remove `donor_censored_display`; keep the `donor_name_blocklist` key, relabelled
*"Flag words — highlighted in the review queue"*; add `donor_banner_slots` (int 0–10, default 5,
0 = banners off), bounded in `donorSettings()` and in the write validator.

### 18.7 Public wall (`/api/pool/donors`, `donate.html`)

- Card `name` = the **approved, unexpired** name, else null; `name_state` ∈ `shown` · `masked` ·
  `expired` (`censored` is gone — an unapproved name simply is not there).
- `banner: { url, width, height } | null` — **only** on league cards with `rank ≤ donor_banner_slots`
  and an approved, unexpired banner. Past strip: never.
- **D-03 layout:** a **Top-N spotlight** above the league — rank 1 full width, 2–N in a grid; the
  banner in a 4:1 box, `object-fit: contain`, `width`/`height` attributes set (no layout shift),
  `alt` = the name or "Donor #N", `loading="lazy"`; a spotlight card without a banner shows the
  name large. Ranks N+1… keep today's compact cards. Past strip unchanged.
- **D-01 copy rewrite:** the examples table becomes: `rig01-donate10` → *"this rig donates 10 % of
  what it earns — your other rigs are unaffected"*; whole-name `donate10`; plain `rig01`; typos
  ignored; *"To change or stop: rename the rig and restart the miner. It applies from that rig's
  next share (shares from the last hour keep the old tag if a block is found soon)."* The
  `yourbrandname` row and the raise row are **deleted**.
- **New D-01b "Your donor name & banner":** set it on your account page (Donor profile) with your
  mining IP + rig password; every name and banner is **reviewed before it appears**; the top N
  donors show a banner — 800 × 200 recommended, PNG/JPG/GIF, ≤ 300 KB; one fallback line: contact
  the operator (the pool's contact link) if you can't pass the check.
- Keep *"Names are chosen by the donors…"* reworded: *"Names and banners are chosen by donors and
  reviewed by the pool before they appear."*

### 18.8 Account page (`account-settings.html`)

- Donation row: *"10 % of new earnings from 2 of 5 rigs online"* + the donating rig names; tooltip
  states the per-rig rule and "rename + restart to change". The ceremony text is **deleted**.
- P-03 workers table: a `donates 10 %` badge per tagged rig.
- New **Donor profile** panel (shown when `donor_profile.eligible`, or with a one-line "donate from
  any rig to unlock" otherwise): current name + state; name form; banner upload with a client-side
  preview and the same size/dimension checks *as a hint* (the server is the check); pending /
  rejected (+ reason) / approved lines; withdraw and remove buttons; the two proof fields reuse the
  Goblin-destination form's inputs and help text. The banner line says whether it is displaying
  ("top 5 — showing" / "you're #8 — shows while you're in the top 5").

### 18.9 Security notes for the review pass

- **Money.** The only donation input is `shares.worker_name`, which a stranger controls for **their
  own** shares only — a stranger tagging your address donates their work, never yours. So §J6-7's
  threat (redirect up to 100 % of a victim's future credit) has no state left to attack. The review
  must prove **no money path still reads `miner_incentives.donation_percent`** (grep + a test that
  sets the column to 100 and asserts it moves nothing), and that `donated[a] ≤ gross[a]` for every
  address, including `donate100` and mixed-tag addresses.
- **Profile writes** need both proofs, aged; a donation debit; not blocked; one pending per kind —
  so the queue is bounded by eligible donors and a stranger who mined to an address briefly passes
  neither the age floor nor (without the rig password) the AND.
- **Upload.** Bytes-sniffed allowlist without SVG; header-parsed dimensions bounded (a decoded frame
  ≤ 1600 × 400 × 4 B); size capped by multer before buffering; server filename; pending bytes only
  in the DB; approved files only under `/uploads/` (sandbox CSP + nosniff); the admin image route
  sends the stored mime with nosniff + sandbox + no-store. A polyglot is served as an image and
  cannot render as a document.
- **Leakage** (`test-public-leakage.js` must assert): no pending name, pending image, reject reason,
  blob, decider id or full address on `/api/pool/donors`; `banner` absent below the slot rank and
  on the past strip; `/api/account/:addr` never carries the pending text or bytes. The reject reason
  **is** shown on the donor's own (public, address-addressable) account page — the admin UI says so
  beside the reason field.
- **Type traps** (memory `project_config_loader_type_traps`): `donor_banner_slots` bounded on read
  and write; `which` and `kind` closed enums; `:id` parsed and range-checked.

### 18.10 Status

| Part | Scope | State |
|---|---|---|
| 1 | Money path: per-share donation, v1 parking/capture removed, `liveDonations()` + the additive API fields, tests | **done 2026-09-24, not VPS-tested** — uncommitted; `npm test` 1134 → 1145 (19 suites); deltas in §18.11; as-built in `script07_implementation.md` §10.6 |
| 2 | Profile backend: tables, `lib/donor-profiles.js` (validation, sniff + dims, state machine, files), miner routes, `requireBothProofs` generalised, account `donor_profile`, settings keys | **done 2026-09-24, not VPS-tested** — uncommitted; `npm test` 1145 → 1298 (20 suites, new `test-donor-profiles.js` 153); deltas in §18.11 *Part 2*; as-built in `script07_implementation.md` §10.6 *Part 2*. The admin transitions exist in the lib and are tested but have **no route** until Part 3, so nothing can be approved yet |
| 3 | Admin: queue + image route + approve/reject/remove/block, `donors.html` rewrite, nav badge, v1 moderation removed | **done 2026-09-24, not VPS-tested** — uncommitted; `npm test` 1298 → 1310 (20 suites); deltas in §18.11 *Part 3*; as-built in `script07_implementation.md` §10.6 *Part 3*. Approved NAMES now show on the wall; banners reach no public page until Part 4. Banner previews use a plain same-origin `src`, so the admin CSP is unchanged (delta 1) |
| 4 | Public: `/api/pool/donors` v3, `donate.html` D-01/D-01b/D-03 spotlight, api-docs, leakage tests | **done 2026-09-24, not VPS-tested** — uncommitted; `npm test` 1310 → 1331 (20 suites); deltas in §18.11 *Part 4*; as-built in `script07_implementation.md` §10.6 *Part 4*. Approved banners now reach the public wall (top `donor_banner_slots` league ranks only). 390 px probe: 0 overflow with 0, 1 and 5 banners, both themes |
| 5 | Account page: donation row, workers badge, Donor profile panel | **done 2026-09-24, not VPS-tested** — uncommitted; `npm test` 1331 → 1343 (20 suites); deltas in §18.11 *Part 5*; as-built in `script07_implementation.md` §10.6 *Part 5*. The v1 account aliases are dropped (delta 1). 390 px probe: 0 overflow in four states, both themes |
| 6 | Review of 1–5 against §18 + §18.9 (a separate cold session), docs + memory fold | **done 2026-09-24** — uncommitted; every §18.9 point answered with evidence in §18.11 *Part 6*; one fix (R6-1, the `match` → `wrong_kind` refusal code), one operator decision (R6-2, the 7-day `immutable` cache on `/uploads/` outlives a banner takedown — **closed 2026-09-24, accepted, won't fix**), three notes; `npm test` 1343 → 1345 (20 suites) |
| 7 | VPS acceptance on testnet with live miners (replaces §16.11 Part 6) | **not run as a testnet pass — operator decision 2026-09-24:** acceptance happens on the live MAINNET pool instead. Nothing in §18 is VPS-verified until that run is recorded here |

### 18.11 Build deltas against §18.2 / §18.3

Recorded by the build session of each part. Part 6's review answers go here too.

**Part 1 (2026-09-24)**
1. **`donorWall` takes `live`, not `rigsOnline`.** The route passes the whole
   `liveDonations()` Map. The old Map-or-function `rigsOnline` option is gone.
2. **`donating_workers` / `donation.workers` is `[{ name, percent }]`**, sorted by name. §18.3
   left the element shape open. The percent is per rig because a mixed-tag address needs it.
3. **"Off ⇒ zeros" does not zero `rigs_online`.** With donations switched off, `rigs_donating`,
   `pct_min`, `pct_max`, `current_percent` and `active_donors` read 0, on the wall, the account
   `donation` object and the admin rows. `rigs_online` keeps its real value because it is not a
   donation reading. The v1 wall never gated it either.
4. **`/api/account/:addr/workers` `donate_percent`** is `null` for an untagged rig **and for every
   rig while donations are off**, and `0` for a `donate0` rig. Off, a tag moves nothing, so no
   badge should claim it does.
5. **The admin list counts a live tag only while donations are on.** An address with nothing but
   a tag gets a row only when that tag would actually donate.
6. **`stratum-server.js` no longer constructs an `IncentivesManager`.** The removed branch was its
   only user.
7. **`validateUsername`'s `donation_percent` has no production reader.** §18.2 says the login log
   line uses it, but that line prints only the worker name. It is kept as §18.2 asks, and the
   grammar tests read it.
8. **v1 donor names already stored keep displaying** through `displayState` on the wall and the
   account page until Part 3. `captureDonorName` has no caller, so no NEW v1 name can appear.
   That is the moderation property the ordering needs.
9. **Verified, not assumed (§18.2):** the ledger shape is unchanged, so `donor-ledger.js`,
   `prizePoolStatement` and `reconciliation.js` needed no edit. A money-path test asserts that
   the prize-pool donation credits equal the sum of donor debits per block, and that donated ≤
   gross for every address.

**Part 2 (2026-09-24)**
1. **`donor_profile` carries four fields §18.6 did not list.**
   - `refusal` is null, `donations_off`, `blocked` or `not_a_donor`: the code a submit would
     get.
   - `name.removed` / `banner.removed` is `{ reason, at }` after an ADMIN removal, while nothing
     is approved in that slot. A donor's own removal is not reported, and who removed it never is.
   - `banner.state` is `shown`, `expired` or `none`, like the name.
   - `banner.showing` is true when a live banner exists and `slot_rank ≤ slots`.

   `eligible` means donations are on AND the address has ≥ 1 debit. `blocked` is separate, so a
   blocked donor sees why instead of "donate to unlock". `name.live` is null unless the state is
   `shown`, which is the v1 `displayState` precedent.
2. **The two "news" fields supersede differently.**
   - `rejected` is about a submission. It counts only while it is the newest row of its kind, so
     a resubmission clears it.
   - `removed` is about the live slot. A waiting resubmission does **not** clear it; an approval
     does. The build first used one "newest row" rule for both, and its own test caught an admin
     removal disappearing behind a pending resubmission.
3. **DELETE needs both proofs, but not donations on, a debit, or an unblocked address.**
   Removing your own data is always allowed. §18.6 listed its refusals only for the whole route
   family. It also returns 404 `nothing_pending` / `nothing_live` **before** it spends a proof
   attempt. That is not a new signal, because the account summary already publishes `pending_at`
   and the live state.
4. **Refusal order: cheapest first, and the input is checked before the proofs.** The order is
   donations off, then account, then blocked, then `not_a_donor`, then the name or banner rules,
   then the proofs. A typo therefore never counts as a failed proof attempt toward the per-IP
   throttle. On the banner route the first four checks run **before** multer reads the body.
5. **"The limit is what stops a large body" (§18.5) is half true.** It was measured with multer's
   real parser on a fake stream:
   - Multer stops **buffering** at the cap, so memory per request stays under about 300 KB.
   - It still reads and discards the rest of the body before the 413. The body's total size is
     bounded by nginx: the public `location /api/` has no `client_max_body_size`, so the 1 MB
     default applies.
   - Busboy trips at **reaching** the limit, so the multer limit is `MAX_BANNER_BYTES + 1`.
     Exactly 300 KB is then accepted, as the rule says.
6. **`lib/donor-profiles.js` does not require `donor-ledger.js`.** Part 4 makes `donorWall` read
   `publicProfiles`, so the require may only run ledger → profiles. The ledger facts arrive as
   values: `isDonor` (fail-closed: anything but `true` is `not_a_donor`), `lastDonatedAt` and
   `slotRank`. `slot_rank` comes from the new `leagueRank()` in `donor-ledger.js`, which uses the
   wall's own ordering; a test checks it against `donorWall`'s numbering.
7. **Approve re-sniffs the STORED bytes** to pick the extension, and refuses a blocked address's
   request as defence in depth, since blocking already withdraws them. It writes the file
   **before** the transaction, unlinks it if the transaction fails, and unlinks the superseded
   file after the commit. A failed unlink is returned as `warning`; it does not abort.
8. **Expiry is per item.** An approved name or banner stops showing `months` after the later of
   the last debit and **its own approval**. v1 used `donor_name_set_at` where this uses the
   approval time. A banner approved later than the name can outlive it.
9. **Name normalisation collapses ASCII whitespace only.** NBSP, zero-width characters and bidi
   overrides are refused rather than tidied into a space. A non-string `name` is refused as
   `name_invalid` and never coerced.
10. **`publicProfiles` returns every approved, unexpired banner.** The slot rule (rank ≤
    `donor_banner_slots`, never on the past strip) belongs to the wall (Part 4). A stored `file`
    that is not `<16 hex>.(png|jpg|gif)` never becomes a URL on either read.
11. **Verified, not assumed (§18.4): no deploy-script change.**
    - The nginx `location /uploads/` aliases `$POOL_APP_DIR/uploads/` with nosniff and the
      sandbox CSP.
    - Both backend rsyncs pass `--exclude='uploads'`.
    - `07_lib_pool_backup.sh` lists `uploads`.
    - The app creates `uploads/donors/` (0755) on the first approval.
12. **Audit actions.** The miner routes log `donor_profile_submit`, `donor_profile_withdraw` and
    `donor_profile_remove` through `auditOwnerProof`. The lib's admin transitions log
    `donor_request_approve`, `donor_request_reject`, `donor_profile_remove`, `donor_block` and
    `donor_unblock`, with `target_type 'donor'`, inside their transaction.
13. **Goblin texts byte-identical (§18.6's "purpose string").** The old and new
    `requireBothProofs` bodies were run against stubbed proofs over all 8 refusal and success
    paths, and the 8 outputs were equal. The donor wording names the harm as "putting words or
    images on the donor wall in your name".

**Part 3 (2026-09-24)**
1. **Banner previews use a plain same-origin `<img src>`, not §18.6's `adminFetch` → blob →
   object URL.** §18.6's reason for the blob was that a plain `<img src>` "would not carry admin
   auth". That is false: the access token is an httpOnly `SameSite=strict` cookie on the default
   path, so a same-origin image request carries it. The operator chose the plain `src` on security
   grounds (2026-09-24, the same day as the build, after a first cut used the blob):
   - The image route's headers (stored mime, `nosniff`, `default-src 'none'; sandbox`) govern
     **every** way the image is viewed, including *Open image in new tab*. An object URL is a copy
     of the bytes on the admin page's origin without those headers. The PNG/JPEG/GIF mime
     allowlist was then the only remaining control.
   - The admin CSP stays `img-src 'self' data:`. The blob needed `blob:` added there, and
     `test-admin-panel.js` now pins its absence.
   - No **Setup nginx** re-run is needed. A code deploy does not rewrite the admin header
     snippet, so the blob version would have left an un-re-run pool with previews that failed
     to load.

   What the blob bought was convenience only: the server's refusal text, and no refetch of a
   `no-store` image on a repaint. A failed load now becomes a generic line of text.
2. **Approved names show on the wall from this part, and v1 names stop showing everywhere.**
   Removing `displayState` left the wall with no name source, so `donorWall` now reads
   `publicProfiles` (approved + unexpired). That is the design's end state, which the plan had
   put in Part 4.
   - Part 4 still owns banners and the slot rule, dropping `current_percent`, `donate.html`, and
     the api-docs v3 row.
   - The wall response dropped `censored_display`, because its setting is gone.
   - `/api/account/:addr`'s `donor_name` / `donor_name_state` are now **derived from
     `donor_profile`** (`none` → `masked`), so the page Part 5 rewrites keeps working.
   - A v1 name is never reviewed, so it never shows. This is the plan's "pre-moderation starts
     clean".
3. **Flags use a wider matching form.** `normalise` also strips space, `.`, `&` and `'`: the
   §18.5 name separators, so `Acme & Co.` equals `acme co` and `s h i t` reads as what it
   spells. `same_as_donor` compares against **other** addresses' approved names only, including
   expired ones (an expired name returns with the next donation). It lists every such address.
   A donor renaming to their own current name is not flagged.
4. **The admin list includes any address with a profile row or a block.** §16.8's set was a
   debit or a live tag. Without the widening, a blocked address with neither could never be
   unblocked, and a pending-only address could not be blocked from the list.
5. **The queue carries more than §18.6 lists.**
   - `current` is the address's approved item of the same kind, so a rename reads as one.
   - `has_image` is true only for a pending blob or an approved file of the server's exact
     shape.
   - `blocked`, `rank` / `lifetime_donated` / `last_donated_at` (one ledger scan per read), and
     the full `decided_*` / `reason` for the history statuses.
   - The pending name text and full address are admin-only by design.
6. **Reject and remove reasons are optional.** A blank reason is stored as NULL, and the donor
   sees "rejected" / "removed" with no text. A **block** note is admin-side only. `profileFor`
   reports `blocked` as a boolean and never the note, and the dialog says so.
7. **`donor_censored_display` rows are not purged.** There is no precedent for deleting a retired
   `pool_config` key. A stored row is inert: nothing reads it and no form binds it. A save that
   sends the key is refused with `Unknown key`.
8. **The queue does not poll.** A timer repaint would wipe a reason being typed. It reloads after
   each decision and on Refresh. The donors list still polls every 60 s.
9. **`AdminTable` gained `onRender(tbody)`.** It runs only after real rows are painted and is
   try/caught. It is the post-render hook the queue needs to fill images, and any list page can
   use it.

**Part 4 (2026-09-24)**
1. **`banner` is `null`, not absent, where no banner shows.** §18.7/§18.9 say "absent below the
   slot rank and on the past strip". The key is on every card, league and past, so both arrays
   keep one shape; its value is `null` there. The leakage and league tests assert `null`.
2. **`ranking` gains `banner_slots`.** §18.7 did not say how the page learns N. The wall now
   sends the bounded setting, and the page uses it for the spotlight size, its "Top N" heading,
   and D-01b's banner line.
3. **A banner needs positive-integer dims to show.** An approved row whose stored width or height
   is not a positive integer shows no banner, rather than an `<img>` the page cannot reserve
   space for. Approve writes only validated dims, so this is defence in depth.
4. **The page's URL fence is the exact server shape**
   (`^/uploads/donors/<16 hex>.(png|jpg|gif)$`), not the plan's "starts with `/uploads/donors/`".
   A prefix test would still pass `../`, a query string, or another extension.
5. **The name is repeated under a banner.** §18.7 put the name in `alt` only. A banner may be a
   logo with no words, so the spotlight card prints the name as text below it too. A card
   without a banner shows the name large inside the 4:1 box, as designed.
6. **D-01 keeps `donate0` as a note, not a row.** "`rig01-donate0` is the same" sits in the plain
   `rig01` row. §18.1 #2 makes a 0 % tag equal to no tag, so it no longer needs a row of its own.
7. **D-01b's expiry sentence and banner line follow the API.** Expiry 0 reads "stay up for as long
   as the pool keeps them approved". Banner slots 0 replaces the banner line with "Banners are
   switched off on this pool". So D-01b never promises what the wall will not do.
8. **The contact fallback reuses branding.js's `data-brand="contact-link"`.** It is a lazy mailto
   that stays hidden with no contact email configured. The sentence ("Ask the pool operator.")
   reads as complete without the link.
9. **`current_percent` is gone.** It was dropped from the card as §18.3 planned. A grep of
   `public_html/`, `admin-panel/`, `lib/` and `index.js` finds only the comment that records the
   removal. The route comment's v1 phrase "a stored % is dormant" was also rewritten to the
   per-share rule.

**Part 5 (2026-09-24)**
1. **The v1 aliases are dropped from `/api/account/:addr`**: `donation_percent` (= `pct_max`) and
   the `donor_name` / `donor_name_state` pair. §18.3 planned this for once the page switched.
   `account-settings.html` was their last reader. A grep of `public_html/` and `admin-panel/` finds
   none; `index.js` names them only in the comment that records the removal. `lib/` still has
   `validateUsername`'s own `donation_percent` (the login parser's field, kept by §18.2, not this
   one) and comments about the dead column. The `API_DOC_META` row no longer
   documents them, and `test-public-leakage.js` pins their absence. A browser holding a cached
   pre-Part-5 page reads the missing `donation_percent` as 0 and hides the row until it reloads.
2. **When the P-05 donation row shows.** It shows while `rigs_donating > 0`, and as *"paused — no
   tagged rig online"* only when `donor_profile.eligible` (donations on AND ≥ 1 donation debit).
   Otherwise it is hidden, so a miner who never tagged a rig sees no row. With mixed tags, the
   second line gives each rig's % (*"rig01 (5 %), rig02 (20 %)"*). At most six names are listed,
   then *"+N more"*. The row links down to P-09 whenever the panel is visible.
3. **Badge only for a % above 0.** The workers route sends `0` for a `donate0` rig, and §18.1 #2
   makes that equal to no tag, so it gets no badge.
4. **Panel visibility.**
   - The panel is hidden when `donor_profile` is null. It is also hidden while donations are off,
     unless something is pending or live, since withdrawing and removing are always allowed
     (§18.11 *Part 2* #3).
   - The proofs and the two columns show when a submit is possible (`refusal === null`), or when
     something can be withdrawn or removed. A not-yet-donor sees one "donate from any rig to
     unlock" line.
   - The banner upload is hidden at `slots = 0`.
5. **Client-side checks: some block, some only warn.**
   - **They block** for the name rules. The page's `DP_NAME` / `dpCheckName` are the server's
     rules, and `test-donor-profiles.js` evaluates the page's function from its source and pins it
     to `validateName` over a 19-name matrix. The file type (the same magic bytes as `SNIFFERS`)
     and the 300 KB limit also block.
   - **They only warn** for banner dimensions. A browser applies a JPEG's EXIF rotation to
     `naturalWidth`/`Height`, while the server reads the raw header, so the two can legitimately
     disagree.
6. **Previews are `data:` URLs, not `blob:`.** The public vhost CSP is `img-src 'self' data: …`, so
   an object URL would not load. No CSP change was needed. `createObjectURL` stays confined to the
   payment-proof download, and the leakage suite pins that.
7. **Where the pending name and banner come from.** The pending name is shown from the POST
   response only. It is kept in the tab, keyed by (address, `submitted_at`), and matched against
   `pending_at`. The chosen file's preview is kept the same way. After a reload the page says *"A
   name submitted <UTC>"*. A different address or the demo clears it (`dpReset`).
8. **The proofs are P-09's own two inputs, not the P-04 box.**
   - Both are cleared after **every** change that goes through. The Goblin card clears only the
     password.
   - They survive a refusal so the donor can retry.
   - They are reset when the address changes.
   - The banner goes up with a fixed filename, `banner`, never the one from the donor's disk.
9. **Removing a live item takes two clicks, confirmed on the page.** The first click arms the
   button for 6 s, and a second click acts. Withdrawing a pending request is one click.
10. **The server's refusal `reason: 'match'`.** When a proof verifies as the *other* kind (an IP
    typed into the password box, or the reverse), `requireBothProofs` refuses with the verifier's
    own success code, `match`. The Goblin route does the same. The page maps it to "right proof,
    wrong box". The naming is left for the Part 6 review; this part does not change it.
    *(Resolved by Part 6: the code is now `wrong_kind` — §18.11 Part 6 R6-1.)*
11. **The refresh after a change re-reads the summary only.** It does not call `lookup()`, which
    would reset the ledger pagers and reload every panel.

**Part 6 — independent review (2026-09-24, a separate cold session)**

Method: §18 read in full, then the working-tree diff. The code was read, not the build notes. A
fresh `npm test` before any edit gave 1343/1343 over 20 suites, which is what §18.10 claims. Three
one-shot scratch harnesses ran outside the repo and left nothing running. Line numbers below are
as of this review.

*Out of scope:* three modified files in the same tree are **not** §18 and were not reviewed:
`lib/withdrawal-scheduler.js` (real `balance_before/after` on settlement rows),
`public_html/payment-history.html` (a Method column + a mined/sent status) and
`public_html/js/reactor-dashboard.js` (the payout teletype's rail tag).

*§18.9 answered:*

1. **Money — no path reads `miner_incentives.donation_percent`.**
   - `grep -rn "donationPercent|setDonation|_applyParkedDonation|donorLabel|donor_label" lib index.js`
     finds only the removal comment in `lib/incentives.js`.
   - Every other `donation_percent` hit is one of three things: the schema, a comment, or
     `validateUsername`'s own login field, which is kept by §18.2 and has no money reader.
   - The two `SELECT *` reads of `miner_incentives` do not change that: `incentiveRow()` has no
     donation reader, and the admin miner view is covered in R6-4.
   - The money input is `parseDonateToken(share.worker_name)` per share (`lib/rewards.js:126`),
     summed into `donateMap` (`:218`) and clamped by `Math.min(want, gross)` in
     `applyToDistribution` (`lib/incentives.js:211`). That loop iterates `minerMap`, so an
     address this block did not credit cannot be debited.
   - Regression: `test-money-path.js` case (f) sets the column to 100 on an untagged address, and
     it donates nothing (`:302`).
   - **Stub run, one block, reward 60, fee 1 %.**
     - Shares: `grin1victim` mined `riga-donate100` (diff 100) and `rigb` (100). A stranger mined
       `stranger-donate20` (200) to the victim's address. `grin1other` mined `rig1` (100), with
       its dead column set to 100.
     - Ledger rows, in order:
       1. victim `credit/block` 47.52
       2. other `credit/block` 11.88
       3. `pool_fee` 0.6
       4. victim `debit/donation` **16.632**, which is 11.88 (rigA × 100 %) + 4.752 (the
          stranger's share × 20 %); `rigb`'s 11.88 is untouched
       5. `prize_pool` `credit/donation` 16.632
     - `grin1other` was not debited.
     - `computeReconciliation`: `integrity_drift` 0, `integrity_ok` and `locked_ok` true, and
       `prize_pool.from_donations` 16.632.
   - **donated ≤ gross** holds by the clamp above, and the per-block invariant tests assert it
     for every address (`test-money-path.js:310`), including `donate100` and mixed tags.
2. **Profile writes.**
   - All three miner routes call `requireBothProofs(…, 'donor_profile')` (`index.js:4689`),
     which has the aged AND of both legs and refuses an evicted anchor.
   - `donorSubmitRefusal` (`:4921`) runs before the input check and the proofs. It checks in
     this order: donations off, then account, then blocked, then no debit.
   - `lib/donor-profiles.js` re-checks the account and the block inside the submit transaction.
     "One pending per kind" is the partial unique index. The lib's tests drive both indexes.
   - The `/api/account` path mount (`index.js:979`) applies `GRIN_ADDR_RE` to these routes too,
     so the `prize_pool` / `pool_fee` pseudo-accounts are unreachable. They would fail
     `not_a_donor` anyway.
3. **Upload.**
   - The sniff is the three binary `SNIFFERS` only. `parseDimensions`
     (`lib/donor-profiles.js:100`) is bounds-checked and wrapped in try/catch. multer caps the
     file at `MAX_BANNER_BYTES + 1` (`index.js:4906`), and the banner route refuses before
     multer reads the body (`:4958`).
   - The server filename is 16 random hex plus the sniffed extension, fenced by `FILE_RE`
     (`:207`), with `path.dirname` containment on every write, read and unlink.
   - Pending bytes live only in `donor_requests.image`, NULLed on every decision. The admin image
     route sends the stored mime, `nosniff`, `default-src 'none'; sandbox` and `no-store`
     (`index.js:7569`). The nginx `/uploads/` block and the Express fallback both send `nosniff`
     plus a sandbox CSP.
   - **Fuzz:** 43 hand-built cases, then 60,000 random tails behind real PNG/JPEG/GIF signatures.
     There were **0 throws**, and every accepted image was inside 320–1600 × 80–400.
     - Parsed correctly: GIF87a and GIF89a, 800×200.
     - Refused as `banner_unreadable`: a PNG truncated at 20 and at 23 bytes, zero width or
       height, a bogus IHDR length or type, and a signature with nothing after it.
     - Refused as `banner_dimensions`: `0xFFFFFFFF` × `0xFFFFFFFF`, and a 65535² GIF or JPEG.
     - JPEG: a DHT (C4) before the SOF is skipped, and fill bytes and RSTn/TEM markers are
       skipped. Refused: a segment length that points past the end, a length of 0 or 1, a
       truncated SOF, an SOF length below 8, and SOS before any SOF.
     - Refused as `banner_type`: SVG, WEBP, and a string or plain array.
4. **Leakage — the complete list of public routes that touch `donor_requests`.** Nothing else
   public reads the table. The admin dashboard's pending count sits behind `secureAdmin`.
   - `GET /api/pool/donors` reads it through `publicProfiles`, which selects approved rows only
     and never `image` (`:593`). Per card it emits `name` (approved and unexpired, else null),
     `name_state` (`shown`/`masked`/`expired`) and `banner` `{url, width, height}`. The banner is
     built only under `inSlot` (`lib/donor-ledger.js:297`); it is null otherwise and always null
     on the past strip.
   - `GET /api/account/:addr` reads it through `profileFor`, whose rows are `READ_COLS`
     (`:476`): no `image`, and the name only from approved rows. It emits `donor_profile`
     `{eligible, blocked, refusal, name{live, state, pending_at, rejected{reason,at},
     removed{reason,at}}, banner{live_url, width, height, state, pending_at, rejected, removed,
     slot_rank, slots, showing}}`.
     - `removed` is non-null only for an ADMIN removal, and who removed it is never emitted.
     - The reject and remove reasons are public by design (§18.9).
   - `POST …/donor-profile/name` returns `{success, kind, status, name, submitted_at,
     replaced_pending}`. This is the only place the pending text is ever echoed, and only to the
     submitter.
   - `POST …/donor-profile/banner` returns `{success, kind, status, mime, width, height, bytes,
     submitted_at, replaced_pending}`.
   - `DELETE …/donor-profile/:kind` returns `{success, kind, which, status}`. Its 404
     `nothing_pending` / `nothing_live` repeats what `pending_at` and `state` already publish.
5. **Type traps.** `donor_banner_slots` is `intRange(0, 10)` on write and `boundInt(…, 5)` on
   read, and is re-bounded by `bannerSlots()` in the wall. `kind` and `which` are closed enums.
   `:id` goes through `parseId` (`/^[0-9]{1,15}$/`, a safe positive integer). The queue's
   `?status=` is checked against `STATUSES`.
6. **Docs honesty.** Every §18.10 total and every per-suite count in `script07_implementation.md`
   §10.6 matches the fresh run, including `test-donor-profiles.js` 187. The 390 px probe claims
   were not re-run; they are the build sessions' own reports.

*Findings:*

- **R6-1 (fixed) — a refusal carried the success code `match`.**
  - `requireBothProofs` refused a leg that verified as the *other* kind with
    `ipProof.reason || 'ip_no_match'`. `verifyOwnerProof`'s reason on a hit is `'match'`, so
    both the response and the owner-proof audit row read `ok:false, reason:'match'`. That is
    misleading to anyone reading the audit log, and the page had to map a success word to an
    error.
  - It is `wrong_kind` now (`index.js:4738`, `:4745`), on the Goblin route too. The refusal
    **text** is unchanged, so the Goblin strings stay byte-identical. The page's `DP_REASONS`
    key followed.
  - Test first: two checks in `test-donor-profiles.js` failed before the edit and pass after it.
    Suite 1343 → 1345.
- **R6-2 (CLOSED 2026-09-24 — accepted by the operator, won't fix) — a banner takedown does not
  reach caches for up to 7 days.** Why accepted: this is a moderation-latency issue, not a
  vulnerability. Every banner is pre-moderated, so an offensive one is live only after an admin
  approved it. The wall stops referencing a removed banner at once, and its 16-hex URL is known
  only to someone who already saw it. Re-open only if a takedown ever has to be immediate. The
  analysis below is kept as written.
  - `location /uploads/` sends `Cache-Control: public, max-age=604800, immutable`
    (`07_grin_mining_public_pool.sh:1730`), and the Express fallback sends the same. So
    `removeLive` / a replacing approve unlinks the file, but anyone who already loaded it keeps
    it, and on a `cloudflare_proxy` pool the CDN edge keeps **serving** it at its URL for up to
    a week.
  - The wall stops referencing it at once, and the 16-hex name is unguessable. But an approved
    offensive banner is exactly when `remove` gets used, and its URL is public to whoever saw
    the wall.
  - Candidate fix: a `location /uploads/donors/` block (and Express parity) with a short
    `max-age` and no `immutable`, or a CDN purge on remove. Either one is a nginx change and
    needs a **Setup nginx** re-run. Neither was done, so a deploy of §18 still needs no nginx
    re-run.
- **R6-3 (note, accepted) — GIF frames are not bounded, only the logical screen.**
  - A GIF image descriptor can declare a frame larger than the logical screen. Browsers clip it
    to the canvas, so §18.9's "decoded frame ≤ 1600 × 400 × 4 B" holds for the canvas.
  - The number of frames is bounded only by 300 KB. Every banner is reviewed by a human before
    it is public, so this is accepted.
- **R6-4 (note) — the admin miner view still ships the dead v1 columns.**
  `GET /api/admin/miners/:addr` returns `SELECT * FROM miner_incentives` (`index.js` ~7284), so
  the raw JSON still carries the dead `donation_percent` and the six `donor_*` columns. It is
  admin-only, and no admin page renders them (`miners.html` does not read `incentives`). This
  goes away with the column cleanup §18.2 defers.
- **R6-5 (note) — a donor's account read costs a full donor-ledger scan.** `/api/account/:addr`
  now runs `leagueRank` for any address with a donation debit, which is the same composite
  donor-ledger scan the wall does. The public route is uncached. The account page does not poll,
  and the wall already pays this cost. It belongs with the SQLite-capacity open items (full scans
  on the shared synchronous DB), not here.

*Checked and holds:*
- Admin writes are `freshAdmin`, the reads are `secureAdmin`, and every decision's audit row is
  written inside its transaction.
- Blocking withdraws pending rows in the same transaction.
- Approve re-sniffs the stored bytes, writes the file before the transaction, and unlinks it on
  failure.
- The removed v1 routes are gone, and `test-admin-guards.js` pins them.
- The only `donor_censor*` references left are the unread schema columns.
- `donate.html` and the account panel escape every donor string and fence banner URLs to the
  exact `FILE_RE` shape.
- There is no v1 copy on either page.
- `bash -n scripts/07_grin_mining_public_pool.sh` passes.

**§19.17 Part C4 (2026-10-04) — names auto-checked.** Donor names are no longer pre-moderated: the shared name
rule (donor shape, §18.5's character set, §16.4's reserved words, `names.blocked_words`) checks them and a pass is
live at once; `banned_donor_names` + a Live / Removed / Banned list replace the name queue; the §18.6 flag hints and
`donor_name_blocklist` are retired. Banners are unchanged. The deltas are §19.15 *Part C4*, as-built
`script07_implementation.md` §10.13 *Part C4*.

## 19. Games platform (/play/) — games, events, chat (DESIGN 2026-09-27; Parts 1–6 built 2026-09-27, Parts 7–10 2026-09-28, independently reviewed (Part 11) 2026-09-28, approved nicknames (Part 12) 2026-09-28, NOT VPS-tested; v2 "open community" DESIGNED 2026-10-03 — §19.17; C1–C4 built 2026-10-04 and independently reviewed (R1) the same day, C5 built 2026-10-04, C6 built 2026-10-04, C7 built 2026-10-04 and C5–C7 independently reviewed (R2) the same day, NOT VPS-tested)

Operator discussion 2026-09-26; the three open questions (D18–D20) answered 2026-09-27. GRINIUM
runs **live on mainnet** with a small group of miners, and the operator wants something that makes
them a community: games, competitions **between addresses**, and a moderated public chat. One
constraint sits above every decision here: **nothing in this section may slow down, restart or
endanger mining.**

The build is broken into 14 sessions (0–13) plus one operator VPS checkpoint. The per-session plan
is kept outside the repo, as for §16–§18. **This section is the contract those sessions build
against.** When a build finds this section wrong, it records the change in §19.15 and does not
diverge silently.

### 19.1 Decisions (operator, 2026-09-26/27 — FINAL unless a build finds a hard reason)

| # | Decision | Why |
|---|---|---|
| D1 | **Points and plays are worthless outside the games.** They are never GRIN, never transferable between addresses, never tradable, and there is no shop in v1. No games code path may write a pool money table, and D5 makes that structurally impossible. A future "spend points" feature may only buy things *inside* the games (cosmetics, themes) and must never convert, transfer or pay out. | Once a point can move between addresses or turn into GRIN it has a price. A price invites farming, Sybil addresses and support disputes. Worthless points keep every cheat below the effort line, so the fairness rules below only have to be *fair*, not bank-grade. |
| D2 | **A separate service**: `grin-games` (mainnet) / `grin-games-testnet`, OS user **`grinplay`**, **zero npm dependencies** (`node:http` + `node:sqlite`, Node ≥ 24, already on the box for the pool). It binds `127.0.0.1:8081` (mainnet) / `127.0.0.1:8091` (testnet); both ports were checked free in `scripts/` on 2026-09-26. | The pool's stratum server shares **one** Node process and **one** synchronous `DatabaseSync` connection with the API (`lib/db.js`, the `busy_timeout` comment). Any slow statement in that process stalls share submission for every miner, **whatever file it touches**. So a separate DB file is necessary but not enough; the games need a separate process. Zero dependencies means no lockfile, no `npm audit` and nothing to vendor. |
| D3 | **DB = `grinium-games.db`** in a DATA dir outside the code dir. Code is `/opt/grin/pubgames/<net>/`; data is `/opt/grin/pubgames-data/<net>/grinium-games.db`. Pragmas: WAL, `synchronous=NORMAL`, `busy_timeout=2000`, `foreign_keys=ON`; file mode 0600. | The code dir is `rsync --delete`d on every deploy. The pool learned this the hard way: `uploads/` was pruned on every deploy until it was excluded by name (the comment above `pool_deploy_code`). With the data outside the code dir, that trap cannot happen. |
| D4 | **Same domain, path `/play/`.** The static shell is served by nginx from `/var/www/grin-play` (testnet `/var/www/grin-play-testnet`), OUTSIDE the pool docroot. The API is at `/play/api/`, proxied to the games service. Move to a subdomain only if a game ever needs a third-party engine, WASM or a looser CSP. | One origin, one certificate and one nav. `pool_deploy_web` `rsync --delete`s `$POOL_WEB_DIR`, which would prune a `/play/` living inside it. Loosening the CSP on a shared origin would also weaken the admin panel's, which is why anything that needs it moves to its own host. |
| D5 | **The pool owns proofs and mining data. The games service never reads `pool.db`**, not even read-only. It reaches the pool only through THREE internal routes on the pool's own `127.0.0.1` listener (§19.3), and the pool reaches it through ONE admin proxy (D11). `grinplay` is not in the `grinpool` or `grinsecret` groups, so file permissions enforce this. | A second reader on `pool.db` holds WAL read snapshots that can stall checkpoints, and it would need the pool's file permissions, which open everything else too. One narrow route with a bounded query is something we can measure and cap. |
| D6 | **Internal-route auth = a shared link secret** in `/opt/grin/conf/grin_pubgames_link_<net>`, owner **`grinplay`**, group **`grinpool`**, mode **0440**. The games service reads it as owner; the pool reads it through its primary group. It travels as the header `X-Games-Link` and is compared with `crypto.timingSafeEqual`. Internal routes live **outside `/api/`** (nginx only proxies `/api/…` and a few exact files to the pool), **and** the vhost gains an explicit `location ^~ /internal/ { return 404; }`. | Two independent controls, because either one alone is one typo away from open. *Refined from the first sketch*, which had a new group `grinlink` joined by both users: a running process keeps the groups it started with, so that design cost the pool one restart after install. Owner + primary group needs no group change, so it needs **no pool restart**. Part 3 verifies with `id grinpool` that `grinpool` is the pool unit's primary group. |
| D7 | **The real client IP travels with every verify call.** The games service passes the player's IP in the request body. The pool's verify route feeds **that** IP to `verifyOwnerProof(db, addr, proof, clientIp)`, and the route is NOT behind the pool's generic per-IP limiter. The games service rate-limits per IP itself before it calls. | Every games call arrives at the pool from `127.0.0.1`. One throttle bucket for everyone means one attacker locks every player out. The pool's own per-(address, IP) and per-IP proof throttles only work when they see the real IP. |
| D8 | **Login = address + one proof (mining IP or rig password), verified by the pool once.** The games service then issues its OWN session (§19.5): cookie `grin_play`, `HttpOnly; Secure; SameSite=Strict; Path=/play/`, 14 days, stored as `sha256(token)`. /play/ has a session list and "log out everywhere". Proof hashes and salts never leave the pool. | Miners have no pool session: every money action sends a per-request proof. A game needs a session, or the player would retype a proof on every move. Rigs with trivial passwords (`x`, `123`, `d=…`) never record a password proof (§17), so those miners can log in by IP only, from the rig's network. /play/ says so. **Amended 2026-10-03 (§19.17, D24):** a second login kind — a **guest** account, login name + password, checked by the games service itself with **no pool call** — issues the same session (`proof_kind 'guest'`, §19.17.3). No session of either kind authorises a money route (D32). |
| D9 | **Posting in chat needs an AGED, non-anchor proof.** `verifyOwnerProof` already returns `slot` (`set` \| `anchor`) and `age_seconds` (null = old). The session stores `chat_ok_after = login_at + max(0, min_age − age)`, so a session opened with a fresh proof can chat once that proof would have aged. `slot === 'anchor'` never gets chat. The default minimum age is 24 h, with a **floor of 1 h**: the floor is a module constant a setting may raise but never remove. An optional operator switch requires the PASSWORD proof for chat. | A stranger who mines a few shares to your address joins your proof set (§17). For payouts that is harmless, because the money goes to you. In chat it is impersonation. An anchor is an evicted credential that cannot be revoked. The floor and the setting are two controls, so they must not share one number. **Amended 2026-10-03 (§19.17, D26):** for a **guest** the gate is the **account's** age, `guest_chat_min_age` (default 24 h, the same floor constant), which replaces the proof-age and recent-mining gates a guest can never pass; guests also have their own switch, stricter rates, links always held, and reports that never count toward auto-hold. |
| D10 | **Plays come from active mining MINUTES, not hashrate.** A minute is 60 s of `hashrate_history` window in which the address had accepted shares (the tracker writes one row per address per 60 s sampling window, and only for addresses with shares, per `lib/hashrate-tracker.js recordHashrates`). Defaults: 10 active minutes = 1 play, at most 24 plays earned per UTC day, the same for every address. | A whale and a small miner get the same number of plays, so skill decides the score, not hashrate. Plays lag mining by up to one sync interval (5 min). **Amended 2026-10-03 (§19.17, D25):** `plays_balance_cap` default 100 → **999**, so miners can bank plays. **Guests** earn none from mining: their balance is **set** to `guest_daily_plays` (default 5) at the first spend or `/me` of each UTC day, never saved up (§19.17.4). The visible word on /play/ becomes "tickets"; internal names stay `plays`. |
| D11 | **The admin UI lives in the POOL admin panel**, which has the one admin auth system (JWT + IP allowlist + 2FA + step-up). The pool route `/api/admin/games/*` proxies to games `/internal/admin/*`, adding the link secret and `X-Admin-User`. Destructive actions (§19.11) require step-up, exactly like the pool's own. | The games service contains **zero** admin-auth code. A second login system would be a second thing to attack and a second thing to keep in step. |
| D12 | **Master switch `games.mode` = `off` \| `preview` \| `on`**, a POOL setting, default `off`. In `preview`, /play/ works by direct URL but the nav link stays hidden, which allows acceptance on the live mainnet pool without announcing it. The branding payload gains `games: { mode, chat }`; the nav item carries `data-games` and shows ONLY when `mode === 'on'`. That is the opposite default of `data-incentives`, which ship visible. Chat has its own switch, `games.chat_enabled`. | The pool is live. The feature must be switchable off from the one panel the operator already uses, and it must be testable in production without being visible. **Amended 2026-10-03 (§19.17, D30):** the defaults become `mode = 'on'`, `chat_enabled = true`, and the games DB adds a **launch state** (`preview` on a fresh DB) that only the games admin's **Go live** moves to `on`. Everything this row says about `mode` now applies to the **effective** mode = min(pool mode, launch) (§19.17.2), so a fresh install still starts hidden. In `preview` the chat bubble (D23) shows only to a browser that has opened /play/. |
| D13 | **Every game runs in a sandboxed iframe** `sandbox="allow-scripts"`, NEVER with `allow-same-origin`, served from `/play/games/<id>/frame/`. Its origin is opaque, so the frame gets no cookies and cannot call `/play/api/`. The parent shell makes every API call and talks to the frame by `postMessage` (§19.7). | `allow-scripts allow-same-origin` on a same-origin document is no sandbox at all: the frame can remove its own sandbox. A commercial arcade reviewed during the discussion shipped exactly that, and its SDK also posted to `'*'`. |
| D14 | **The browser never sends a score or a result, for any kind of game.** Each game declares a fairness kind in its manifest. **v1 builds `match`**: turn-based, where the server holds the only game state and validates each move as it arrives, and the opponent is a bot or another address. Event metrics use the `mining` kind (§19.9), computed from synced activity, which is cheat-proof because the pool already verified the PoW. `skill` (server seed + input-log replay) and `chance` (commit-reveal) are **reserved**: specified in §19.8, built with their first game, refused by the v1 registry. | *Amended by D20* (the first sketch had chance + skill games). A game where the server computes the outcome from moves it validated itself cannot be forged by the client. |
| D15 | **Events live in the games service, NOT in pool campaigns.** v1 event kinds are `game_results`, `mining_minutes` and `active_days` (§19.9). Rewards are points + a badge, never GRIN. | This reverses earlier advice in the discussion. Pool campaigns are GRIN lottery draws in `pool.db`, and games points are worthless and live in `grinium-games.db`. Coupling the two would put games writes back on the pool's DB. |
| D16 | **Resource isolation at the OS level.** Games unit: `MemoryMax=384M`, `CPUWeight=20`, `IOWeight=20`, `Nice=10`, `TasksMax=64`, `NoNewPrivileges=yes`, `ProtectSystem=strict`, `ProtectHome=yes`, `PrivateTmp=yes`, `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`, `ReadWritePaths=` the data dir + log dir only. | If games crashes, is OOM-killed or is stopped, nothing changes for miners, and /play/ shows "games are offline". The kernel enforces this; we are not relying on the code being well-behaved. |
| D17 | **Extension points, so a new game or event never touches platform code.** A game = one folder `play/games/<id>/` (manifest + `rules.js` + `frame/`), loaded by a registry at startup. An event kind = one module `play/server/lib/events/<kind>.js`. Chat messages carry a `room` column, and v1 uses only `global`. Team events arrive later as one more event kind. | The platform is built once and reviewed once. A game that needs a platform edit is a platform bug, and it is fixed generically. |
| D18 | **Backup: YES.** The pool's `B) Backup` archive includes a `sqlite3 .backup` snapshot of `grinium-games.db` when it exists. Restore asks about it separately (`[Y/n]`). A missing or broken games DB NEVER fails a pool backup or a pool restore. | The file is small, and it holds exactly what players would lose on a rebuild: ratings, finished games, event results and points. |
| D19 | **Names in v1 = the masked address only**: the pool's public mask, `index.js maskAddr`, 9 leading + 4 trailing characters. Approved nicknames are the *optional* Part 12: pre-moderated, games-owned, always shown with the masked suffix and never alone. | The public-list invariant (`maskAddr`'s comment: no public route emits a full address in a LIST) carries over unchanged. Nicknames need a review queue of their own, so they wait until the core platform has been reviewed. **Amended 2026-09-28 (Part 12):** the operator chose nicknames; built as §19.16 — pre-moderated, and composed on the server into the one public `name` as `Nick (grin1abcd…wxyz)`, so no response carries a nickname without its mask. **Amended 2026-10-03 (§19.17, D27):** pre-moderation is **replaced** by an automatic check — 3–20 of `A–Z a–z 0–9`, reserved words, one pool-owned blocked-word list, banned names, uniqueness on the matching form — and a passing name is **live at once**; the operator, and moderators for removal only, post-moderate. Miners still show `Nick (grin1abcd…wxyz)`; guests show `Nick · guest` or `Guest-XXXX`. §19.16 is kept as the history of the Part 12 flow. |
| D20 | **The v1 game is CHESS, as one `match` game with two modes.** First **vs a built-in bot** (Parts 5–6, the operator's solo test path), then **player vs player between two addresses, correspondence pace** (Part 10): hours to days per move, with the page polling while it is open. Live timed games come later. **No team games in v1.** Block Hunt and Grin 2048, the first sketch's defaults, are dropped from v1; either can come back later as a game folder once its kind is built. | Chess is turn-based and its rules are deterministic, so the server can validate every move and a forged move is impossible. **A bot game is a match with the bot in one seat, played move by move on the server**, not a client-side game replayed afterwards: with a deterministic bot running in the browser, a player could try lines and undo them before submitting, which is unlimited takebacks. Move-by-move also reuses one engine for both modes. The bot is small, deterministic and budgeted, and runs in the games process. Stockfish was rejected: it is GPL, needs WASM (a CSP loosening, see D4), and on the server it would burn CPU on the pool's box. Correspondence first because the community is small and two players are rarely online together; it also needs no push connection. **Accepted limit:** engine-assisted play cannot be detected. Points are worthless (D1), so this is recorded, not fought. |
| D21 | **Chat moderators are miner addresses the operator appoints** (added 2026-09-28 by the Part 8 build, answering the operator's question "can I add a moderator to help me?"; **confirm at acceptance**). A moderator acts from /play/ with their own games session, never from the pool admin panel. They can delete or approve a chat message and mute its author for ≤ 24 h. They cannot act on operator messages or on other moderators, and have no ban, purge, word list, settings, points, events or full addresses. Acting needs a chat-capable session and, by default (`mod_requires_password`), one opened with the rig **password**. Every action is a `mod_actions` row as `mod:<address>`. A ban ends the appointment; removal takes effect on the next request. Their messages show a "Mod" badge, computed at read time. Appointing and removing are step-up admin writes (§19.11). | The pool has exactly **one** admin account (registration closes after the first), behind the nginx IP allowlist + 2FA. Making a helper a second pool admin would open the pool's security core — money, settings, wallets — to give someone chat buttons, and would mean allowlisting their IP. Player-session *authorization* adds no second login system, so D11 still holds: the games service has no admin *authentication*. Every power given is reversible and logged. The password default exists because an IP proof can be a CGNAT neighbour (§19.13 #7). **Amended 2026-10-03 (§19.17, D27/D32):** moderators may also **remove** a nickname — never ban a name or block a player, and never touch the operator's, their own or another moderator's name. A moderator is still a **miner address**; a guest (`g:`) can never be appointed. |

### 19.2 Architecture + impact isolation

```
 browser ──HTTPS──► nginx :443 (the pool vhost)
                     ├─ /  /api/…        → pool 127.0.0.1:8080          (unchanged)
                     ├─ ^~ /internal/    → return 404                   (NEW, explicit)
                     ├─ ^~ /play/api/    → games 127.0.0.1:8081         (own zones, own body caps)
                     ├─ ^~ /play/games/  → alias /var/www/grin-play/games/  (sandboxed frames, frame CSP)
                     └─ ^~ /play/        → alias /var/www/grin-play/        (the shell, shell CSP)

  games service  grin-games · user grinplay          pool  grin-pool-manager · user grinpool
  ┌───────────────────────────────┐                  ┌──────────────────────────────────┐
  │ node:http, zero deps          │  POST /internal/games/verify-proof ──►                │
  │ grinium-games.db (own conn)   │  GET  /internal/games/activity    ──►  pool.db       │
  │                               │  GET  /internal/games/config      ──►  (stratum +    │
  │                               │      header X-Games-Link, direct to    API, one      │
  │                               │      127.0.0.1:8080, never via nginx   process)      │
  │ /internal/admin/*  ◄──────────┼── admin proxy ◄── /api/admin/games/* (JWT+allowlist+2FA)
  │ /play/api/health   ◄──────────┼── health probe, every 60 s, 1 s timeout, async       │
  └───────────────────────────────┘                  └──────────────────────────────────┘
```

| Layer | Isolation | What it prevents |
|---|---|---|
| Process | Own systemd unit, own Node process, own event loop | A slow games statement or a CPU-heavy bot move stalling share submission |
| OS user | `grinplay`; not in `grinpool`/`grinsecret`; can read the link file only | Games reading `pool.db`, the pool config, wallet or node secrets |
| DB | `grinium-games.db`, own connection, own VACUUM | Games writes contending with pool writes for one WAL |
| nginx | Separate locations and rate-limit zones; `/internal/` answers 404 | Players reaching the internal routes; games traffic eating the pool's zones |
| systemd | D16 limits | A leak or runaway loop taking memory or CPU from the pool |

**What the pool does because of the games, and nothing else:** it answers the three internal
routes, forwards admin-initiated proxy calls, runs one unref'd probe timer, and adds one field to the
branding payload. **Nothing** runs on the stratum, share, block, reward or payout paths, and there is
no pool-side cron. Worst-case pool DB cost:

- **activity:** at most one window of ≤ 3600 s per 5-min tick in steady state (≤ 24 in a
  bounded catch-up). The query SEARCHes `idx_hashrate_time` (§19.3); the index is not covering
  for `grin_address`/`window_seconds`, so the row lookups equal the active miner-minutes in the
  window (50 miners ≈ 3 000).
- **verify-proof:** the same cost as one account-page proof check, 1 to 8 async scrypts (§17.7).
  It is gated by the games service's per-IP limit, then by the pool's per-(address, IP) and per-IP
  throttles keyed on the real IP (D7).
- **config:** one settings read every 60 s.

**Failure behaviour.**
- *Games down:* the pool is unaffected. Branding reports `games.mode = 'off'` while the probe is
  unhealthy, so the nav link hides. /play/ shows the offline state.
- *Pool down or restarting:* login fails with "the pool is unreachable" and activity sync pauses,
  then catches up within the bound. Games that are already running go on, because chess never
  needs the pool.
- *Mode unknown:* the games service keeps the last known mode for ≤ 10 min, then treats it as
  `off`. This refines the sketch's "link down = off", which would have taken /play/ offline for
  every pool restart.

**Impact budget — both VPS runs (checkpoint A, Part 13) MUST prove all five on the live box:**
1. Installing, deploying, restarting, stopping or crashing games never restarts
   `grin-pool-manager` (`systemctl show grin-pool-manager -p NRestarts -p ActiveEnterTimestamp`
   before/after). The ONE planned pool restart is Part 2's code deploy.
2. `/internal/games/*` answers 404 through nginx from outside, and 401 locally without the secret.
3. The activity query plan uses an index (no `SCAN hashrate_history`), and a 1-hour window returns
   in < 50 ms on the live DB.
4. `systemctl stop grin-games` leaves every pool page and stratum unaffected; /play/ shows the
   offline state; the nav is unchanged.
5. Games memory is capped: a stress loop in preview mode kills and restarts only games.

### 19.3 Pool ↔ games contract

**Link secret.** `/opt/grin/conf/grin_pubgames_link_<net>`, 48 random bytes, base64 (64 chars),
`grinplay:grinpool 0440`. Both sides re-read it when its mtime changes, and both treat a missing or
short file (< 32 bytes) as "not configured". The secret is never passed in argv, a systemd
`Environment=` line (visible in `systemctl show`), a log line or a response. Only the **path**
is configured. **Rotation** writes a temp file with the same owner and mode and `mv`s it over the
old one. Both sides pick up the new mtime on their next call, so rotation restarts **nothing**; calls
in flight during the swap may get one 401.

**Common rules for `/internal/games/*`** (pool side, all in `lib/games-link.js`):
- Mounted on the pool's existing listener (`config.host:config.port`, `127.0.0.1:8080` mainnet /
  `8090` testnet), **before** `express.json()` and any generic rate limiter.
- A request carrying `X-Forwarded-For` or `X-Real-IP`, or arriving on a non-loopback socket, gets
  404 before the secret is looked at (a third guard beside nginx and the secret; §19.15 *Part 2*).
- The **first** middleware checks the secret, before body parsing beyond the size cap and before
  any DB read or scrypt. A wrong secret costs one comparison.
- Errors are JSON `{ ok:false, error:'<code>' }`: `link_not_configured` 503 · `unauthorised` 401
  (missing and wrong secret return the same code) · `bad_request` 400 with `field` · unknown path
  404. Every response carries `Cache-Control: no-store`.

| Route | Request | Response | Bounds / notes |
|---|---|---|---|
| `POST /internal/games/verify-proof` | JSON ≤ 2 KB: `{ address, proof, client_ip }` | `{ ok:true, method:'ip'\|'password', slot:'set'\|'anchor', age_seconds:int\|null }` or `{ ok:false, reason }`, where `reason` is exactly what `verifyOwnerProof` returned (incl. `too_many_attempts`) | `address` passes the same `GRIN_ADDR_RE` as `/api/account` **and** the pool network's prefix. `proof` is a string of 1–256 chars. `client_ip` is required and must pass `net.isIP`: **never** fall back to `req.ip` (always `127.0.0.1`). The route calls `verifyOwnerProof(db, address, proof, client_ip)` and audits via `auditOwnerProof` with action `games_login`. It never returns a hash, salt, row or the proof. |
| `GET /internal/games/activity?from=&to=` | unix seconds | `{ from, to, rows:[{ address, seconds, minutes }] }` | Both integers; `0 < to − from ≤ 3600`; `to ≤ now`; `from ≥ now − 7 d`; else 400. ONE statement: `SELECT grin_address, COUNT(*) AS minutes, SUM(window_seconds) AS seconds FROM hashrate_history WHERE recorded_at > ? AND recorded_at <= ? AND hashrate_gps > 0 AND grin_address NOT IN (?, ?) GROUP BY grin_address`, with the two placeholders bound from `RESERVED_ADDRESSES` (`pool_fee`, `prize_pool`). `EXPLAIN QUERY PLAN` (no `ANALYZE`) must show `SEARCH … idx_hashrate_time`, never `SCAN hashrate_history`. Full addresses are fine here: the route is internal and secret-guarded, not public. |
| `GET /internal/games/config` | — | `{ mode:'off'\|'preview'\|'on', chat_enabled:bool, net }` | From the pool-settings `games` section. Typed values: a quoted `"false"` must never read as true. |

**Admin proxy (pool → games).** `/api/admin/games/*` on the pool forwards to
`http://127.0.0.1:<games_port>/internal/admin/*`.
- **Pool-side guards:** reads (`GET`) go through `secureAdmin`. Writes go through `secureAdmin`,
  plus `freshAdmin` (step-up) for the paths in the §19.11 list, enforced **before** proxying.
- **Headers added:** `X-Games-Link`, `X-Admin-User` (the JWT user's name), `X-Admin-Stepup: 1|0`,
  `X-Request-Id`.
- **Transport:** JSON body ≤ 64 KB; 2 s timeout. Status and JSON body pass through. Games
  unreachable → 503 `{ error:'games_offline' }`; non-JSON from games → 502 `{ error:'games_bad_response' }`.
- **Audit:** step-up paths also write one pool `admin_audit_log` row (`games_admin`, method + path).
- **Games side:** `/internal/admin/*` requires the link secret, a non-empty printable
  `X-Admin-User` ≤ 64 chars, and `X-Admin-Stepup: 1` on step-up paths. That last check is defence
  in depth; the pool is the enforcer. Every write adds a `mod_actions` row. The games service never
  decodes `%2F` in a path and matches routes exactly, so an encoded `..` cannot move a request between
  prefixes.

**Health probe (pool → games):** every 60 s, `GET http://127.0.0.1:<games_port>/play/api/health`
(1 s timeout), on an unref'd timer. The pool caches `{ healthy, checked_at }` and **never awaits it
from a request handler**. Games answers `{ ok, net, schema, launch, uptime_s }`: no secrets, no counts
(`launch` since C2 — §19.17.2; the pool combines it with its own mode and re-probes once after a Go live).

**Pool settings section `games`:**

| Key | Type | Default | Rule |
|---|---|---|---|
| `mode` | enum `off`\|`preview`\|`on` | `off` → **`on`** (§19.17, D30; built in C2, 2026-10-04) | combined with the games' launch state (§19.17.2) |
| `chat_enabled` | bool | `false` → **`true`** (§19.17, D30; built in C2, 2026-10-04) | — |

`games_port` (8081 mainnet / 8091 testnet) and `games_link_secret_file`
(`/opt/grin/conf/grin_pubgames_link_<net>`) are **pool.json keys** (`lib/config.js` defaults), not
settings, and the installer writes them only if absent. The admin proxy sends the secret to that port,
so an admin-editable port would let a stolen admin session aim it at any localhost service. A bad
value disables the link and never blocks the pool's boot (§19.15 *Part 2*).

### 19.4 `grinium-games.db` schema (v1 + migrations 2–5)

The rules that apply to every table:
- Times are unix seconds (INTEGER).
- A day is a UTC `YYYY-MM-DD` TEXT.
- No column may hold an integer that could pass 2^53, because `node:sqlite` throws on read past
  that. Seeds and hashes are hex TEXT.
- Migrations are numbered and recorded in `meta.schema_version`. Each runs in one transaction and
  is idempotent.
- `meta.net` is checked at boot, so a mainnet DB never opens as testnet.

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);      -- schema_version, created_at, net

CREATE TABLE players (
  address       TEXT PRIMARY KEY,
  first_seen    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL,
  plays         INTEGER NOT NULL DEFAULT 0 CHECK (plays  >= 0),     -- = Σ ledger(kind='plays')
  points        INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0),     -- = Σ ledger(kind='points')
  points_day    TEXT,                                               -- UTC day points_today counts
  points_today  INTEGER NOT NULL DEFAULT 0,
  banned_until  INTEGER,                                            -- NULL = not banned; 253402300799 = forever
  muted_until   INTEGER,
  badges_json   TEXT NOT NULL DEFAULT '[]'                          -- badge ids from a server-side list
);
CREATE INDEX idx_players_points ON players(points DESC);

CREATE TABLE sessions (
  token_hash    TEXT PRIMARY KEY,                                   -- hex sha256(token); the token is never stored
  address       TEXT NOT NULL REFERENCES players(address),
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,                                   -- created_at + 14 d, never extended
  last_seen     INTEGER NOT NULL,
  ip_coarse     TEXT,                                               -- /24 (v4) or /48 (v6): display only
  ua_hint       TEXT,                                               -- ≤ 64 chars, display only
  proof_kind    TEXT NOT NULL CHECK (proof_kind IN ('ip','password','guest')),  -- 'guest' since v5: a TABLE REBUILD (below)
  proof_slot    TEXT NOT NULL CHECK (proof_slot IN ('set','anchor')),           -- a guest session is 'set'
  chat_ok_after INTEGER,                                            -- NULL = never (anchor, or password-only chat with an IP proof); a guest: sign-up + the age gate (a record — chat re-reads it live)
  revoked_at    INTEGER
);
CREATE INDEX idx_sessions_address ON sessions(address, revoked_at);
CREATE INDEX idx_sessions_expiry  ON sessions(expires_at);

CREATE TABLE activity_sync (                                        -- one row per synced window = the watermark
  id INTEGER PRIMARY KEY, window_from INTEGER NOT NULL UNIQUE, window_to INTEGER NOT NULL,
  rows INTEGER NOT NULL, synced_at INTEGER NOT NULL
);
CREATE TABLE activity_daily (
  address TEXT NOT NULL, day TEXT NOT NULL,
  seconds INTEGER NOT NULL DEFAULT 0,                               -- Σ window_seconds; minutes = seconds / 60
  plays_awarded INTEGER NOT NULL DEFAULT 0,                         -- plays already credited for this day
  PRIMARY KEY (address, day)
);
CREATE INDEX idx_activity_day ON activity_daily(day);

CREATE TABLE ledger (
  id INTEGER PRIMARY KEY, address TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('plays','points')),
  delta INTEGER NOT NULL CHECK (delta <> 0),
  reason TEXT NOT NULL,        -- mining_minutes | match_cost | match_refund | match_result | event | admin_adjust | admin_void
  ref TEXT,                    -- 'w:<window_from>' | 'm:<match_id>:<seat>' | 'e:<event_id>' …
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_ledger_address ON ledger(address, kind, id);
CREATE UNIQUE INDEX uq_ledger_ref ON ledger(address, kind, reason, ref) WHERE ref IS NOT NULL;  -- exactly-once credits

CREATE TABLE matches (
  id            INTEGER PRIMARY KEY,
  game_id       TEXT NOT NULL,
  game_version  TEXT NOT NULL,
  mode          TEXT NOT NULL CHECK (mode IN ('bot','pvp')),
  state         TEXT NOT NULL CHECK (state IN ('seek','challenge','active','finished','aborted','declined','expired','void')),
  seat1         TEXT,                        -- address | 'bot:<level>' | NULL (open seat). Chess: seat1 = white, moves first
  seat2         TEXT,
  created_by    TEXT NOT NULL,
  target        TEXT,                        -- direct challenge only: the invited address
  params_json   TEXT NOT NULL,               -- { move_seconds, colour:'seat1'|'seat2'|'random', bot_level }
  seed          TEXT,                        -- hex; bot tie-breaks + random colour
  position      TEXT NOT NULL,               -- game-defined (chess: FEN)
  ply           INTEGER NOT NULL DEFAULT 0,
  turn_deadline INTEGER,
  draw_offer_by INTEGER CHECK (draw_offer_by IN (1,2)),
  result        TEXT CHECK (result IN ('seat1','seat2','draw')),
  reason        TEXT,                        -- checkmate|resign|timeout|stalemate|repetition|fifty|material|max_plies|agreement|abort|void
  rated         INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, last_move_at INTEGER
);
CREATE INDEX idx_matches_seat1  ON matches(seat1, state);
CREATE INDEX idx_matches_seat2  ON matches(seat2, state);
CREATE INDEX idx_matches_target ON matches(target, state);
CREATE INDEX idx_matches_state  ON matches(state, turn_deadline);            -- timeout sweep, lobby, expiry
CREATE INDEX idx_matches_pair   ON matches(game_id, seat1, seat2, finished_at); -- per-pair rated cap
CREATE UNIQUE INDEX uq_matches_one_bot ON matches(game_id, created_by) WHERE mode = 'bot' AND state = 'active';

CREATE TABLE match_moves (
  match_id INTEGER NOT NULL REFERENCES matches(id), ply INTEGER NOT NULL,
  seat INTEGER NOT NULL CHECK (seat IN (1,2)), move TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (match_id, ply)
) WITHOUT ROWID;

CREATE TABLE ratings (                                              -- DERIVED: recomputable from finished rated matches
  game_id TEXT NOT NULL, address TEXT NOT NULL,
  rating INTEGER NOT NULL DEFAULT 1200, games INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0, draws INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL, PRIMARY KEY (game_id, address)
);
CREATE INDEX idx_ratings_board ON ratings(game_id, rating DESC);

CREATE TABLE results_daily (                                        -- rollup for leaderboards + events
  address TEXT NOT NULL, game_id TEXT NOT NULL, mode TEXT NOT NULL, day TEXT NOT NULL,
  games INTEGER NOT NULL DEFAULT 0, wins INTEGER NOT NULL DEFAULT 0, draws INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0, points INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (address, game_id, mode, day)
);
CREATE INDEX idx_results_board ON results_daily(game_id, mode, day);

CREATE TABLE events (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, game_id TEXT,
  starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL,              -- whole UTC days (§19.9)
  rules_json TEXT NOT NULL, reward_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('scheduled','running','finalising','done','cancelled')),
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX idx_events_state ON events(state, ends_at);
CREATE TABLE event_results (
  event_id INTEGER NOT NULL REFERENCES events(id), address TEXT NOT NULL,
  value INTEGER NOT NULL, rank INTEGER NOT NULL, reward_points INTEGER NOT NULL DEFAULT 0, badge TEXT,
  PRIMARY KEY (event_id, address)
);

CREATE TABLE chat_messages (
  id INTEGER PRIMARY KEY, room TEXT NOT NULL DEFAULT 'global',
  role TEXT NOT NULL CHECK (role IN ('player','operator')),
  address TEXT,                                -- NULL for operator posts
  admin_user TEXT,                             -- operator posts only
  body TEXT NOT NULL,                          -- plain text, normalised (§19.10); never HTML
  state TEXT NOT NULL CHECK (state IN ('visible','held','deleted')),
  hold_reason TEXT, created_at INTEGER NOT NULL, deleted_by TEXT, reason TEXT
);
CREATE INDEX idx_chat_room    ON chat_messages(room, state, id);
CREATE INDEX idx_chat_address ON chat_messages(address, created_at);
CREATE TABLE chat_reports (
  id INTEGER PRIMARY KEY, message_id INTEGER NOT NULL REFERENCES chat_messages(id),
  reporter TEXT NOT NULL, reason TEXT, created_at INTEGER NOT NULL, resolved_at INTEGER, resolved_by TEXT,
  UNIQUE (message_id, reporter)
);
CREATE INDEX idx_reports_open ON chat_reports(resolved_at, id);

CREATE TABLE mod_actions (
  id INTEGER PRIMARY KEY, admin_user TEXT NOT NULL, action TEXT NOT NULL, target TEXT,
  details_json TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX idx_mod_actions_time ON mod_actions(created_at);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT);

-- v2 (Part 8, D21): chat moderators appointed by the operator, and the chat word list
CREATE TABLE moderators (
  address  TEXT PRIMARY KEY REFERENCES players(address),
  added_by TEXT NOT NULL, added_at INTEGER NOT NULL, note TEXT
);
CREATE TABLE chat_words (
  word TEXT PRIMARY KEY, added_by TEXT NOT NULL, added_at INTEGER NOT NULL
);

-- v3 (Part 12, §19.16): approved nicknames — a request log; the partial unique indexes make
-- "one pending + one live per address" and "no two live nicknames alike" database facts
CREATE TABLE nicknames (
  id           INTEGER PRIMARY KEY,
  address      TEXT NOT NULL REFERENCES players(address),
  name         TEXT NOT NULL,                -- as typed, after normalise (§19.16)
  norm         TEXT NOT NULL,                -- the matching form: lower-case, separators out, leet folded
  state        TEXT NOT NULL CHECK (state IN ('pending','approved','rejected','replaced','withdrawn','removed')),
  submitted_at INTEGER NOT NULL,
  decided_at   INTEGER, decided_by TEXT, reason TEXT   -- decided_by = admin name | 'self'; reason shown to the player
);
CREATE UNIQUE INDEX uq_nick_pending  ON nicknames(address) WHERE state = 'pending';
CREATE UNIQUE INDEX uq_nick_live     ON nicknames(address) WHERE state = 'approved';
CREATE UNIQUE INDEX uq_nick_norm     ON nicknames(norm) WHERE state = 'approved';
CREATE INDEX idx_nick_state ON nicknames(state, id);
CREATE INDEX idx_nick_address ON nicknames(address, submitted_at);
CREATE INDEX idx_nick_norm ON nicknames(norm, state);

-- v4 (Part C3, §19.17.5): names checked automatically and live at once. 'pending' stays in the
-- nicknames CHECK and stops being written; the migration re-checks Part 12's rows (§19.17.5).
CREATE TABLE banned_names (
  norm      TEXT PRIMARY KEY,                  -- the matching form: every spelling of it is refused
  name      TEXT NOT NULL,                     -- as the operator typed it (admin only)
  banned_at INTEGER NOT NULL,
  banned_by TEXT NOT NULL,
  reason    TEXT
);
ALTER TABLE players ADD COLUMN nick_blocked INTEGER NOT NULL DEFAULT 0 CHECK (nick_blocked IN (0,1));
ALTER TABLE players ADD COLUMN nick_changed_at INTEGER;          -- last own change (the cooldown)
ALTER TABLE players ADD COLUMN nick_refused_day TEXT;            -- UTC day nick_refused_n counts
ALTER TABLE players ADD COLUMN nick_refused_n INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_players_nick_blocked ON players(nick_blocked) WHERE nick_blocked = 1;

-- v5 (Part C5, §19.17.3/§19.17.4): guest accounts. A guest is a players row (address = 'g:' + 16
-- base32) plus a guests row with the credentials. A delete removes the guests row (the login name
-- is free at once) and keeps the players row with deleted_at set, so history still resolves.
CREATE TABLE guests (
  id            TEXT PRIMARY KEY REFERENCES players(address),   -- 'g:' + 16 base32 (80 random bits)
  login_name    TEXT NOT NULL,                     -- the sign-up name as typed; only its owner's /me returns it
  login_norm    TEXT NOT NULL UNIQUE,              -- its matching form (§19.17.5): one login per form
  pass_hash     TEXT NOT NULL,                     -- 'v1$salt$hash', scrypt N=16384 r=8 p=1 (the pool's format, copied)
  created_at    INTEGER NOT NULL,                  -- the account's age: the guest chat gate (D26)
  last_login_at INTEGER NOT NULL                   -- the idle job (guest_idle_days)
);
CREATE INDEX idx_guests_idle ON guests(last_login_at);
-- The per-/24 (/48) sign-up count (guest_signups_per_ip / 24 h). Its own table, unlinked to the
-- account: a delete must not hand its IP a fresh slot, and an IP is never stored beside the account
-- it made. Rows older than 24 h are deleted hourly.
CREATE TABLE guest_signups (
  id         INTEGER PRIMARY KEY,
  ip_coarse  TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_guest_signups_ip ON guest_signups(ip_coarse, created_at);
ALTER TABLE players ADD COLUMN kind TEXT NOT NULL DEFAULT 'miner' CHECK (kind IN ('miner','guest'));
ALTER TABLE players ADD COLUMN deleted_at INTEGER;               -- a deleted guest: "deleted guest", never ranked
ALTER TABLE players ADD COLUMN guest_day TEXT;                   -- UTC day of the last ticket top-up (§19.17.4)
-- sessions: v5 also widened proof_kind (above). SQLite cannot ALTER a CHECK, so the migration
-- copies the rows out, drops the table, recreates it with this text, copies them back — in one
-- transaction. Not "create new + RENAME": a rename stores the name quoted, and this block is
-- compared with the live schema as text.
```

*Against the first sketch:* `rounds` / `rounds_daily` became `matches` + `match_moves` /
`results_daily` (D20: v1 has no round-based game). The materialised `leaderboard` table was dropped
because `ratings` **is** the rating board and `results_daily` serves the period boards with an
index. `activity_daily` stores `seconds` instead of `minutes`, so a change to the pool's sampling
interval cannot miscount, and it stores `plays_awarded`, which makes the sync idempotent without a
per-player daily counter. The reserved `skill`/`chance` kinds will add a `rounds` table by migration
(§19.8).

### 19.5 Auth + sessions

**`POST /play/api/login` `{ address, proof }`** (body ≤ 4 KB; nginx zone `…_gamelogin` 20 r/m, then
the service's own limits). Steps, in this order:
1. Shape-check the address: `GRIN_ADDR_RE` plus this network's prefix (`grin1` mainnet,
   `tgrin1` testnet).
2. Apply the per-IP and per-address token buckets. Failure history survives the window, so backoff
   keeps growing. **This happens before any pool call.**
3. If `players.banned_until > now`, refuse with 403 `banned`. This is also before the pool call, so
   a banned address costs the pool nothing.
4. `pool-link.verifyProof(address, proof, clientIp)`. `clientIp` is `X-Real-IP` only when the
   socket peer is loopback, otherwise the socket address.
5. On `ok`, create the session:
   - The token is 32 random bytes, base64url. The response sets
     `Set-Cookie: grin_play=<token>; Path=/play/; HttpOnly; Secure; SameSite=Strict; Max-Age=1209600`.
   - Store `sha256(token)` as hex, with `proof_kind = method` and `proof_slot = slot`.
   - `chat_ok_after`:
     - `slot === 'anchor'` → NULL (never).
     - The `chat_requires_password` setting is on and `method === 'ip'` → NULL.
     - Otherwise → `now + max(0, minAge − (age_seconds ?? Infinity))`, where
       `minAge = max(CHAT_MIN_AGE_FLOOR = 3600, setting chat_min_proof_age, default 86400)`.
   - Upsert `players`. If the address already has 20 live sessions, the oldest is revoked.
6. On failure, map the pool's `reason` to the **same wording the account page uses** for it
   (`account-settings.html`). The login must reveal nothing the account page does not already show.

**Using a session.** Every authenticated route looks up `sha256(cookie)`. The session must be
unrevoked and unexpired, and the player unbanned. `last_seen` is written at most once per 5 min,
not on every request. Expiry is a hard 14 days from creation; activity does not extend it.

**CSRF.** Three layers:
- `SameSite=Strict`.
- Every POST must be `Content-Type: application/json`. A cross-site form cannot send that without a
  preflight, and nothing answers a preflight.
- If an `Origin` header is present, it must equal the pool's origin.

| Route | Returns |
|---|---|
| `GET /play/api/me` | `{ address, address_masked, plays, points, chat:{ enabled, can_post, available_at, reason }, sessions:n }`. `address` is the caller's own and is not a list. |
| `GET /play/api/sessions` | the caller's sessions: `created_at, last_seen, ip_coarse, ua_hint, current` |
| `POST /play/api/logout` · `POST /play/api/logout-all` | revoke this session · revoke every session of the address |

A ban revokes every session of the address when it is applied.

### 19.6 Plays + points ledger

**Earning (activity sync, every 5 min).**
- **Windows.** The sync walks forward from the watermark (the last `activity_sync.window_to`) to
  `now − 120 s`, which gives the pool's minute rows time to land. A window never crosses a
  whole-hour boundary: `to = min(next hour boundary, now − 120)`. So a window is ≤ 3600 s, never
  spans UTC midnight, and belongs to exactly one day.
- **Catch-up.** At most 24 windows per tick. Windows older than 7 days are recorded as skipped
  (`rows = -1`) and not credited: after a long outage, older minutes are lost, not flooded in.
- **Crediting one window.** The work below is one transaction; the `UNIQUE(window_from)` insert
  makes a repeated window a no-op. For each row:
  1. `activity_daily.seconds += seconds`.
  2. `due = min(plays_daily_cap, floor(seconds_day / 60 / minutes_per_play))`.
  3. `delta = due − plays_awarded`, clamped so `plays` never passes `plays_balance_cap`.
  4. Write a ledger row `(plays, delta, 'mining_minutes', 'w:<window_from>')`.
  5. `players.plays += delta` (the `players` row is created if missing: miners collect plays before
     their first login).
  6. `plays_awarded = due`.

  Minutes cut by the balance cap are lost, not deferred.
- **Settings.** `minutes_per_play` (default 10, 1–1440), `plays_daily_cap` (24, 1–1440),
  `plays_balance_cap` (100, 1–10000). A change applies from the next window and never recomputes
  an earlier UTC day. Because `due` is taken from the day's running total, it does re-rate the
  **current** day: lowering `minutes_per_play` or raising the cap mid-day credits the difference at
  the next window, and the opposite change credits nothing more that day (§19.15 *Part 11* #3).

**Spending.**
- **Bot game:** `bot_play_cost` plays (default 1; 0 is allowed, handy for free testing in preview).
- **PvP:** `pvp_play_cost` plays per side (setting, default 1, range 0–10; a free match pays no
  points, as a free bot game). The creator of a seek or challenge pays at creation; the acceptor pays
  at acceptance — the cost recorded in the match at creation, so both pay the same.
- **Refunds** (reason `match_refund`, ref `m:<id>:<seat>`, so exactly once):
  - to the creator, when a seek or challenge is declined, expires or is cancelled before anyone
    accepts;
  - to both sides, when a match is aborted before each side has moved once.

**Points (reason `match_result`, ref `m:<id>:<seat>`).**
- **Bot game:** a win earns `bot_points[level]` (default 1 / 2 / 3); a draw earns half, rounded down.
  These are the game manifest's `points.bot` values, and a free game (`bot_play_cost` 0) pays none
  (§19.15 *Part 5* #2–#3).
- **PvP:** only when the match is **rated** (§19.8). A win earns `pvp_win_points` (default 10); a
  draw earns `pvp_draw_points` (5).
- **Daily cap:** `points_daily_cap` per address per UTC day (default 100). Points above the cap are
  not credited.
- **Cap exemptions:** event rewards (bounded by the event's own config) and `admin_adjust`.

**Invariant:** `players.plays = Σ ledger.delta (kind='plays')` and
`players.points = Σ ledger.delta (kind='points')`.
- Every change to either column is in the same transaction as its ledger row.
- A debit never takes a balance below 0: the `CHECK` constraint enforces it, and the debit refuses
  with 409 `no_plays`.
- `ledger.verify()` runs in tests and in the hourly tick. It **logs** drift and never fixes it
  automatically.
- The day boundary is UTC everywhere.

Nothing in this ledger is money, and nothing reads it outside `grinium-games.db` (D1, D5).

### 19.7 Game module contract

**Folder `play/games/<id>/`:**

- **`manifest.json`** fields:

  | Field | Rule |
  |---|---|
  | `id` | `^[a-z0-9-]{2,32}$`, equal to the folder name |
  | `title` | ≤ 40 chars |
  | `kind` | `match` in v1; `skill` \| `chance` are reserved, and the registry refuses them |
  | `version` | ≤ 16 chars |
  | `seats` | 2 |
  | `modes` | ⊆ `['bot','pvp']` |
  | `bot_levels` | e.g. `[1,2,3]` |
  | `move_pattern` | a regex source string; the server and the shell both check a move against it |
  | `move_seconds_options` | integers, e.g. `[86400, 259200, 604800]` |
  | `default_move_seconds` | — |
  | `max_plies` | — |
  | `points` | the defaults behind the §19.6 settings |

  The registry validates every field. A bad game is skipped with a log line and never crashes
  boot.
- **`rules.js`**: UMD, **pure and deterministic**. No I/O, no `Date`, no `Math.random`, no globals.
  The server loads it from the configured games dir only (path containment is checked), and the
  frame loads a copy, used for UI hints only. The `match` API:

  | Function | Returns |
  |---|---|
  | `initial(params)` | `position` (string) |
  | `toMove(position)` | `1 \| 2` |
  | `legal(position)` | `move[]` |
  | `apply(position, move)` | `position \| null` (null = illegal) |
  | `status(position, history)` | `{ over:false }` or `{ over:true, result:'seat1'\|'seat2'\|'draw', reason }`. `history` = the prior positions, for repetition. |
  | `bot(position, level, seed, ply)` | a legal `move`. Optional; required when `modes` includes `bot`. Deterministic, and must respect a node budget (`BOT_NODE_BUDGET`). |

  Every call is wrapped in try/catch. A throw leaves the match unchanged, answers 500 and is
  logged.
- **`frame/`**: `index.html`, `game.js`, `game.css`. It renders and captures input; it is never an
  authority.

**Chess (`play/games/chess/`).**
- **Notation.** A position is a FEN; a move is UCI (`e2e4`, `e7e8q`),
  `move_pattern ^[a-h][1-8][a-h][1-8][qrbn]?$`.
- **Game end.** `status` covers checkmate, stalemate, **automatic** threefold repetition, the
  **automatic** fifty-move rule, insufficient material, and `max_plies` = 600, which is a draw.
  There are no draw *claims*: the server applies them.
- **Rules code.** Our own implementation, proved by **perft**:
  - start position, depth 1–4 = 20 / 400 / 8 902 / 197 281;
  - "Kiwipete", depth 1–3 = 48 / 2 039 / 97 862;
  - plus castling-through-check, en passant, under-promotion and pinned-piece cases.

  Vendoring chess.js (BSD-2-Clause) instead is allowed only under `games/chess/vendor/` with its
  licence and a pinned SHA-256, recorded in §19.15.
- **Bot.** All levels are deterministic given `(FEN, seed, ply)`, and the node budget is 20 000
  per move:
  - level 1: a seeded random legal move;
  - level 2: greedy 1-ply by material, with a seeded tie-break;
  - level 3: 2-ply alpha-beta over material + piece-square tables.

  No opening book, no engine, no WASM.

**Frame ↔ shell protocol (`postMessage`, `protocol: 1`).**
- The frame is `<iframe sandbox="allow-scripts" src="/play/games/<id>/frame/?v=<version>">`.
  **Never** `allow-same-origin`. Its origin is opaque, and its CSP has `connect-src 'none'`, so it
  can reach nothing.
- The shell accepts a message only when `event.source === frame.contentWindow` and `event.data`
  is a plain object whose `type` is in the table below and whose fields match that type's schema
  (types, lengths, `move_pattern`). Anything else is dropped. Origins are never compared: a
  sandboxed frame's origin is `"null"`.
- The shell posts to the frame with target `'*'`, the only target an opaque origin allows.
  **Therefore no message to a frame ever carries a token, a cookie, a full address or anything
  not already on screen.**

| Direction | `type` | Fields |
|---|---|---|
| frame → shell | `ready` | `protocol` |
| shell → frame | `state` | `position`, `last_move` \| null, `you` (1 \| 2 \| null for a spectator), `to_move`, `legal` (only when it is `you`'s turn), `status`, `labels` `{1,2}` (masked address or "Bot level N") |
| frame → shell | `move` | `move` (≤ 16 chars, must match `move_pattern`) |
| shell → frame | `theme` | `mode` (`dark` \| `light`) |

The shell sends the move to the API and then posts a fresh `state` either way, so a rejected move
simply redraws. Resign, draw and abort are **shell** buttons, never frame messages.

### 19.8 Matches (the v1 `match` kind) + the reserved kinds

**Lifecycle.**

| Mode | Path |
|---|---|
| bot | create → `active` immediately (play debited, seed drawn, colour per params) → `finished` |
| pvp seek | open lobby entry, one empty seat → another address takes it → `active` |
| pvp challenge | direct to a `target` address typed by the challenger (they already know it) → target accepts → `active` · declines → `declined` |

- **Unaccepted seeks and challenges** expire after 72 h (`expired`, with a refund).
- **Abort:** `aborted` is possible only while `ply < 2`, and both sides are refunded.
- **Void:** `void` is an admin action (§19.11).
  - *On an active match:* it ends without a result, and both sides get their plays back.
  - *On a finished one:* compensating `admin_void` ledger rows reverse its points, and the game's
    `ratings` are **recomputed** from all finished, rated, non-void matches in `finished_at`
    order. Ratings are a derived table; the recompute is O(matches of that game), fine well past
    this community's size.

**The move — `POST /play/api/matches/:id/move {ply, move}`** (session required; ≤ 1 move/s per
session). The steps below run in ONE `BEGIN IMMEDIATE` transaction:
1. Re-read the match. It must be `active`, and the caller must hold the seat that is to move
   (else 403 `not_your_turn`).
2. `ply` must equal `matches.ply`. A stale tab or a double submit gets 409 `stale`, so exactly one
   of two racing moves wins.
3. If `turn_deadline` has passed, finalise the timeout and answer 409 `timeout`.
4. Check `move` against `move_pattern`, then `rules.apply`. `null` → 400 `illegal_move`.
5. Insert `match_moves` and update `position`, `ply`, `last_move_at` and
   `turn_deadline = now + move_seconds`. Clear `draw_offer_by`: a move declines an offer.
6. Run `rules.status`. If the game is over, **settle** in this same transaction.
7. **Bot mode:** if the game is not over, compute `rules.bot(...)` within the node budget, then
   apply, insert and check status in the same transaction. One request carries the human move and
   the bot's reply.

The response is the match view. The client never sends a position, a result, a score or a ply
other than the current one.

**Other actions:**
- `POST /:id/resign`. In PvP while `ply < 2` it is an **abort** (both refunded): a result at ply 0
  would be a rated win handed over without a game.
- `POST /:id/draw {action:'offer'|'accept'|'decline'}`, PvP only. An offer while the other side's
  offer stands accepts it.
- `POST /:id/abort`, PvP only, while `ply < 2`.
- `POST /play/api/matches` to create a bot game, seek (no `target`) or challenge (`target` = a full
  address of this network).
- `POST /:id/accept` and `POST /:id/decline`; `POST /:id/cancel` (the creator, before anyone
  accepts → `aborted`, reason `cancelled`, refunded).
- Every match view carries `actions` — what THIS viewer may do next (`accept`, `decline`,
  `cancel`, `abort`, `resign`, `draw_offer`, `draw_accept`, `draw_decline`) — so the shell never
  re-derives the rules (§19.15 *Part 10*).

**Timeouts:** when `turn_deadline` passes, the side to move loses (`timeout`); if `ply < 2`, the
match is aborted and refunded instead. This is applied lazily on every read or move of that match,
and by the 5-min sweep over `idx_matches_state`.

**Settling** runs inside the transaction that ends the match:
1. Set `result`, `reason` and `finished_at`.
2. Upsert `results_daily` for each human seat.
3. Write the points ledger rows (unique `ref`, so exactly once).
4. **Rated rule (PvP only):** the match is rated if the unordered pair has finished fewer than
   `pair_rated_daily` (default 3) rated matches this UTC day, counted on `idx_matches_pair` in both
   seat orders. Only a rated match moves `ratings`, pays PvP points **and enters `results_daily`**
   (so the pair cap also bounds every board and event built on it). Elo, K = 24, start 1200,
   integers, zero-sum. `pair_rated_daily` 0 = no PvP match is rated.
   A **free** match (cost 0, bot or PvP) pays no points and enters no `results_daily` row either,
   so a free bot cannot feed a wins board or a `game_results` event (§19.15 *Part 11* #1).
5. A self-match (`seat1 = seat2`) is refused at creation.

**Caps** (settings; defaults):

| Cap | Default |
|---|---|
| Active PvP matches per address (`pvp_active_max`; checked for both sides at accept) | 10 |
| Open seeks + challenges created per address (`pvp_open_max`) | 5 |
| Active bot game per address per game | 1 (a partial unique index) |
| Lobby list | the 50 newest seeks |

**Reads** (every one an indexed lookup):

| Route | Access | Returns |
|---|---|---|
| `GET /play/api/matches/:id?since_ply=` | public while mode ≠ off; seats shown masked | the match view |
| `GET /play/api/matches/mine?state=&before=` | session | paged, 20 per page |
| `GET /play/api/matches/turns` | session | the count of matches where it is the caller's move, + max `last_move_at`: the cheap poll |
| `GET /play/api/lobby` | public while mode ≠ off | open seeks |

**Polling (correspondence pace):**
- `turns`: every 15 s while the page is visible, every 60 s while it is hidden.
- An open PvP board polls its match every 5 s while it is the opponent's move.
- There is no push connection in v1. Live timed games will need SSE, an nginx location with
  buffering off and connection caps, and that is a later design.

**Retention.** Finished PvP matches and their moves are kept: they are small (≈ 30 B per move row)
and players value their history. For finished **bot** matches, `match_moves` is deleted after 60
days and the match row is kept.

**Reserved kinds (built with their first game; the v1 registry refuses them):**
- `skill`: the server issues a seed; the browser returns the INPUT LOG; the server replays it with
  `rules.replay(seed, inputs) → { score, valid }` under `min_seconds`/`max_seconds` and an input
  cap.
- `chance`: the server draws the outcome when the round starts, commits
  `sha256(seed ‖ JSON(outcome))`, and reveals both at settle.

Both add, by migration, `rounds(id, address, game_id, game_version, state 'started'|'settled'|'expired',
seed, commit, outcome_json, inputs_json, score, points, started_at, settled_at, expires_at)`, with a
partial unique index allowing one open round per address per game. Settle is idempotent.

### 19.9 Leaderboards + events

**Leaderboards** (public while mode ≠ off, addresses masked with `maskAddr` semantics exactly):

| Board | Source | Query |
|---|---|---|
| Rating, per game | `ratings` | `ORDER BY rating DESC`; hidden until 5 rated games (provisional) |
| Wins / points, per game + mode, per day / ISO week / month (UTC) | `results_daily` | `WHERE game_id=? AND mode=? AND day BETWEEN ? AND ? GROUP BY address` on `idx_results_board` |
| Points, all-time | `players` | `idx_players_points` |

- **Tie-break,** always deterministic: value DESC, then games DESC (rating board), then address
  ASC.
- The computed board is cached in memory for 60 s.
- **No read scans `matches` or `ledger`.**

**Events (D15).** Event windows are **whole UTC days**, validated at create, because results and
activity are rolled up per UTC day. The kinds, one module each under `lib/events/`, each exporting
`validate(rules)`, `compute(db, event) → [{address, value}]` and `describe(rules)`:

| Kind | Rules | Value |
|---|---|---|
| `game_results` | `{ game_id, mode:'pvp'\|'bot', metric:'wins'\|'points', min_games }` | Σ over `results_daily` in the window |
| `mining_minutes` | `{}` | Σ `activity_daily.seconds / 60` in the window |
| `active_days` | `{ min_minutes }` (default 10) | days in the window with ≥ `min_minutes` |

**Lifecycle**, driven by the 5-min tick:
1. `scheduled` → `running` at `starts_at`.
2. → `finalising` at `ends_at + 10 min`, which gives the last activity sync time to land.
3. → `done`: compute, rank (the deterministic tie-break above), write `event_results`, pay the
   rewards.
4. `cancelled` from any state before `done`: no rewards. Cancelling a `done` event claws nothing
   back; use `admin_adjust`.

`reward_json` = `{ tiers:[{ rank_from, rank_to, points, badge }], participation:{ min_value, points, badge } }`
(the participation `badge` was added in Part 7, §19.15 *Part 7* #7).
Rewards are ledger rows `('points', …, 'event', 'e:<id>')`, so they are unique and paid once. A
badge is appended to `players.badges_json` in the same transaction as the `done` transition. Badge
ids come from a server-side list of ≤ 24-char ids and are never free text.

**Team events** are not in v1. They arrive as one more event kind, plus a `teams` table by
migration (D17).

**Routes:**
- Public: `GET /play/api/leaderboard?game=&board=rating|wins|points&mode=&period=day|week|month|all`,
  `GET /play/api/events`, and `GET /play/api/events/:id` (top 50, masked, plus the caller's own rank
  when logged in).
- Admin (§19.11): `/internal/admin/events` CRUD, cancel, finalise-now.

### 19.10 Chat + moderation

**Reading** is public while mode ≠ off and `chat_enabled`, and needs no session.
`GET /play/api/chat?room=global&after=<id>` returns ≤ 100 `visible` messages, ascending. With a
session, it also returns the caller's own `held` messages, flagged `held:true`. The fields are
`id, created_at, name, role, body, own`. `name` is the masked address — `Nick (masked address)` once the
player has an approved nickname (§19.16) — or "Operator" for `role='operator'`. The response never carries a full address or an IP.

**Posting** (`POST /play/api/chat {body}`, body ≤ 4 KB) requires **every** one of these:
- the pool's `chat_enabled`;
- mode `preview` or `on`;
- a valid session with `chat_ok_after` not NULL and ≤ now (D9);
- with `chat_requires_password` on, a password-proof session;
- the player is not muted or banned;
- ≥ `chat_min_minutes` (default 60) of mining in `activity_daily` over the last `chat_recent_days`
  (7);
- the rate limits: 1 per 5 s and 30 per hour per address, 60 per hour per IP, plus the slow mode
  (`chat_slow_seconds`, 0 = off);
- no identical body from the same address in the last 10 min.

A refusal returns a reason code, and `available_at` when the reason is time-based.

**The body is normalised on the server:**
1. NFC.
2. Newlines become spaces.
3. Remove C0/C1 control characters, the bidi overrides U+202A–U+202E and U+2066–U+2069, and the
   zero-width characters U+200B–U+200D, U+2060 and U+FEFF. Write these as escape sequences in the
   code, never as raw bytes.
4. Collapse whitespace and trim.
5. The result must be 1–280 chars.

The body is stored as **plain text**, and rendering is the client's job.

**Auto-hold** (the message is `held`: visible to its author and queued for review):
- a word-list hit (admin-edited, normalised substring);
- a link-like body (`://`, `www.`, or a `name.tld` pattern) while `chat_hold_links` is on, which is
  the default, because scam links are the main risk;
- `chat_report_threshold` reports (default 3) from distinct addresses on a visible message.

Links are never made clickable.

**Report:** `POST /play/api/chat/:id/report {reason ≤ 200}` needs a **chat-capable** session (the
posting gate above, built in Part 8: "distinct reporters" must mean distinct aged, mining addresses)
and is unique per (message, reporter). Operator messages and your own cannot be reported.

**Keeping open pages current (built in Part 8).** A poll asks only for ids after the newest it has,
so a message deleted, held or approved later would never reach a page that already drew it. Every
state change goes into an in-memory log with a revision number; a poll sends `after`, `rev` and
`epoch` and gets `changes: { removed, held, shown }` too. An unknown epoch (a restart) or a revision
the bounded log has dropped answers `reset: true` with a fresh page (§19.15 *Part 8* #3).

**Rendering:** `textContent` only, **never `innerHTML`**, in the shell and the admin pages alike.
The chat panel always carries the line *"The operator will never ask you for funds, keys or seeds
in chat."*

**The operator badge** exists only on messages posted through `/internal/admin/chat/post`, which
sets `role='operator'` and `address` NULL. `role` is not an input to the public route.

**Moderation** (admin, §19.11):
- list, filtered by state;
- approve a held message; delete one (with a reason);
- mute an address for ≤ 30 days;
- ban an address until a date or forever. A ban revokes its sessions and blocks login, games and
  chat. Unban reverses it;
- purge: delete every message of an address from the last N days;
- word-list edit, operator post, the report queue, and the mod log.

Every action writes `mod_actions` with `X-Admin-User`.

**Moderators (D21, built in Part 8).** From /play/, on the public API with their own session:
`GET /play/api/mod/queue` (held + reported messages, masked names), and `POST
/play/api/mod/messages/:id/{delete,approve,mute}` — mute silences the message's **author** for ≤ 24 h
and never shortens a longer mute. None of it reaches an operator message or another moderator.
`/me` carries `moderator: null | { can_act, reason }`.

**Retention** (hourly tick): messages older than 7 days, or past the newest 2 000 in a room, are
hard-deleted, together with their reports. `mod_actions` is kept 365 days.

### 19.11 Admin surface

**Pages** in the pool admin panel, in a "Games" nav group that shows whatever the mode is (the
operator configures before enabling):

| Page | Contents |
|---|---|
| Settings → **Games** (a pool-owned section, Part 2) | `mode`, `chat_enabled`, and a read-only games-service health line from the probe |
| `games.html` | games-owned settings via the proxy: plays (§19.6), points, chess (bot play cost; PvP play cost, `pair_rated_daily`, the active / open caps — the move-time options stay manifest values), chat (min proof age with the **1 h floor shown**, password-only switch, recent-mining minutes/days, rate limits, slow mode, hold links, report threshold, word list), retention. It links to the pool-owned switches and does not duplicate them. *As built (Part 9):* the Games NAV parent; the form is built from the service's own setting spec, so a new key needs no page edit; the word list lives on `games-chat.html`; the PvP group arrived with Part 10; `mod_requires_password` (D21) is here. |
| `games-chat.html` | the live list, held queue, reports, message actions, operator post box, mod log; **moderators** (D21: list, appoint, remove) |
| `games-players.html` | address lookup (full address, admin only): player row, session count, plays/points, mute/ban/unban, purge, match list with **Void** per voidable match (Part 10, step-up), `admin_adjust`, appoint/remove as moderator |
| `games-events.html` | event CRUD, results, cancel, finalise-now. The window is picked as whole UTC days with **date** inputs, the last day included (built in Part 7: a `datetime-local` snapped to days would show a time that means nothing, §19.15 *Part 7* #12). |
| `games-names.html` | *(Part 12, §19.16)* the nickname queue (oldest first, with flags), the live and rejected lists; approve / reject (the reason is shown to the player) / remove — all step-up |

The pages follow the pool's admin conventions (AdminTable, the settings-form harvester rules) and
leave the admin CSP unchanged.

**Step-up (`freshAdmin`) is enforced POOL-side before proxying** for: ban, unban, purge, match
void, `admin_adjust`, event cancel, and every games-settings write. Delete-one-message, mute,
approve-held, operator post and event create/update are `secureAdmin` only, so live moderation is
fast. The list lives in `lib/games-link.js`, and the games side re-checks `X-Admin-Stepup`.

**The list is of the FAST writes, and it binds the games admin paths (built in Part 2).** GET is
never step-up; every other write is step-up **unless** it is exactly one of these (paths relative
to `/internal/admin/`, `:id` = one path segment):

| Fast write (`secureAdmin` only) | Method + path |
|---|---|
| delete one message | `POST chat/messages/:id/delete` |
| mute | `POST players/:addr/mute` |
| approve a held message | `POST chat/held/:id/approve` |
| operator post | `POST chat/post` |
| event create | `POST events` |
| event update | `POST events/:id` |

So Parts 7–9 must name those six routes exactly that. Any other write, including one added later
without updating `FAST_WRITES`, defaults to step-up (fail closed). Consequences: unmute and
finalise-now are step-up, and a fast action sent as PUT or DELETE is step-up. Part 8 added restore,
purge, the word list, settings and moderator appoint/remove, all step-up by this rule — `FAST_WRITES`
did not change. A moderator's own actions (D21) use the public API, not this proxy. The pool-owned
**Settings → Games** save is step-up too (`'games'` is in `STEP_UP_SETTINGS_SECTIONS`).

### 19.12 Deploy + operations

| | Mainnet | Testnet |
|---|---|---|
| Service / user | `grin-games` / `grinplay` | `grin-games-testnet` / `grinplay` |
| Code | `/opt/grin/pubgames/mainnet/` (root:grinplay, 750/640) | `/opt/grin/pubgames/testnet/` |
| Data | `/opt/grin/pubgames-data/mainnet/grinium-games.db` (grinplay, 700/600) | `…/testnet/…` |
| Web | `/var/www/grin-play` (www-data perms like `pool_fix_web_perms`) | `/var/www/grin-play-testnet` |
| Port | `127.0.0.1:8081` | `127.0.0.1:8091` |
| Link secret | `/opt/grin/conf/grin_pubgames_link_mainnet` (grinplay:grinpool 0440) | `…_testnet` |
| Log | `/opt/grin/logs/grin-games.log` (logrotate `copytruncate`) | `…/grin-games-testnet.log` |
| Bash lib | `scripts/lib/07_lib_pool_games.sh`, prefix `pgs_` | same |

**Menu `P) Play & chat (games)`** in the pool script's Administration group:

| Key | Action |
|---|---|
| 1 | Install / repair |
| 2 | Deploy games code |
| 3 | Nginx (write + reload) |
| 4 | Service control |
| 5 | Status: unit state, `NRestarts`, the port listener, DB size, `meta.schema_version`, the mode from `/internal/games/config` (secret read from the file, never printed) |
| 6 | Logs |
| 7 | Rotate the link secret: atomic replace, **no restarts** (§19.3) |
| 8 | Uninstall: keeps the DB unless a second confirmation; `nginx -t` + reload |
| 0 | Back |

**Nothing under `P` restarts `grin-pool-manager`.**

**Deploy.** `pgs_deploy_code`:
- `rsync --delete`s `server/` and each game's `manifest.json` + `rules.js` into the code dir, which
  holds nothing at runtime, by D3;
- `rsync --delete`s the shell and each game's `frame/` + `rules.js` into the web dir;
- re-applies owners and modes, since `rsync -a` carries the checkout's owner;
- writes a `version.js` asset stamp (a short hash of the deployed tree) so Cloudflare-cached assets
  bust;
- restarts **only** the games service.

`pool_deploy_code` ends with `pgs_deploy_code` when games is installed.

**nginx.** A snippet `/etc/nginx/snippets/script07-<svc>-games-locations.conf` holds the `/play`
locations. The rate-limit zones `…_games` 600 r/m and `…_gamelogin` 20 r/m come through
`nginx_ensure_rate_limit_zones`. The locations:

| Location | Serves | Headers / notes |
|---|---|---|
| `= /play` | 301 → `/play/` | — |
| `^~ /play/api/login` | the games service | 4 KB body cap; `X-Real-IP` |
| `^~ /play/api/` | the games service | 64 KB body cap |
| `^~ /play/games/` | frames | own frame CSP: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; object-src 'none'`. It does NOT include the pool's common header snippet, whose `X-Frame-Options DENY` would block our own frame, so nosniff, Referrer-Policy and HSTS are written out here with a comment naming the snippet they mirror. |
| `^~ /play/` | the shell | the common snippet + the shell CSP (`script-src 'self'`, no inline script, `frame-src 'self'`, `connect-src 'self'`); `Cache-Control: no-cache` on `*.html` |

The pool vhost's `:443` block gains two lines, once:
- `location ^~ /internal/ { return 404; }`
- a **glob** include of `script07-<svc>-games-*.conf`. A glob that matches nothing is not an
  nginx error; checkpoint A verifies that with the snippet absent.

After `nginx -t` + reload, **verify the routes**: `/play/` 200, `/play/api/health` 200 JSON,
`/internal/x` 404. If `nginx -t` fails, remove the snippet and reload, so the vhost is never left
broken. `/play/api/` responses are `Cache-Control: no-store`, so Cloudflare never caches a session
answer.

**Backup (D18).** `B) Backup` adds a `sqlite3 .backup` snapshot of the games DB when present,
using the same two-phase pattern as `pool.db`. Restore asks separately with default Y. A missing
games DB never fails either one.

**Cleanup.** `Z) Cleanup` gains a games group: service, unit, snippet, zone conf, web dir, app dir,
logrotate and link file. The DB sits behind its own confirmation.

**Maintenance**, inside the service:
- **every 5 min:** activity sync, match timeouts and expiry, event transitions;
- **hourly:** session purge, chat retention, bot-match move purge, `ledger.verify()` (log only).
  Each job logs its elapsed time.

The weekly `VACUUM` runs from the pool's `C) Cron` through a wrapper that stops **only**
`grin-games`.

**As built (Part 3, 2026-09-27, not VPS-tested).** Everything above is in
`scripts/lib/07_lib_pool_games.sh`; the pool script carries only hooks. Where the build refined
this section (the unit's write paths, the deploy staging, the `version.js` name, the frame CSP's
`sandbox`, `no-cache` on the whole shell, the restore flow, the cron time, the cleanup prompts),
the change and its reason are in §19.15 *Part 3*. The operator-facing walkthrough is impl §10.13
*Part 3*.

### 19.13 Threat notes for the review pass (Part 11 answers each against the code)

1. **Forged move / result.** Can any request set `position`, `result`, `ply`, points or rating
   directly? Is every move checked by `rules.apply` on the server?
2. **Races.** Two tabs moving the same match at once: does exactly one win (`BEGIN IMMEDIATE` +
   the ply check)? Can a match settle twice, or be refunded and settled both? (`uq_ledger_ref`.)
3. **Plays farming.** Can plays appear without pool-seen minutes? Does a repeated or overlapping
   window double-credit? Is a settings change retroactive? Is the balance cap honoured?
4. **Pair farming / collusion.** Is the per-pair rated cap enforced in both seat orders? Two
   addresses owned by one person remain an **accepted limit**: points are worthless.
5. **Bot abuse.** Can a player take a move back against the bot? Can bot CPU be driven, given the
   node budget, one active bot game and the per-session move rate? Does a throwing `rules.js` leave
   the service up?
6. **Session theft / CSRF.** Cookie attributes exact; token stored hashed; logout-all and ban
   revoke; `SameSite=Strict` + the JSON content type + the `Origin` check on every POST.
7. **Login as someone else.** Games login is exactly as strong as the account page's proof. A
   stranger who mines to your address, or a CGNAT neighbour, can log in as you and spend your
   plays or play rated games in your name. The chat gate is aged (D9); the games actions are not.
   Is that acceptable as written, and is it stated on /play/?
8. **Frame escape.** Is the sandbox attribute exactly `allow-scripts`? Frame CSP `connect-src
   'none'`? Does the shell check `event.source` and each schema? Does any message to a frame carry
   anything secret?
9. **Chat XSS.** Every sink in the shell, the frames and the admin pages: `textContent` only,
   quotes included.
10. **Impersonation.** Can a public request create an operator message? **Masked names can be
    ground:** matching another address's 9…4 mask takes about 2^40 key generations (4 free bech32
    characters in front, 4 at the back), which is hours on a GPU. So a masked name is not an
    identity. The operator badge is the only trusted marker, and the anti-scam line says so.
11. **Chat flood.** Rate limits per address and IP, slow mode, the 4 KB cap, a muted user using a
    second session, and the cost of a 1 000-client poll storm (each GET must be an indexed range
    read).
12. **Pool stall via the internal routes.** Is the secret checked before any parse, DB read or
    scrypt? Is activity bounded and EXPLAIN-checked? Is verify-proof throttled on the real IP? Can
    the games service make the pool run scrypt without limit?
13. **Secret leak.** Is the secret ever in argv, env, a log, a response or an error? File modes;
    rotation.
14. **`/internal` via nginx.** Check every `proxy_pass` location in the vhost, the `^~ /internal/`
    404, encoded-path tricks, and the games' own `/internal/admin/` requiring the secret anyway.
15. **Cloudflare caching.** Shell HTML `no-cache`, API `no-store`, the version stamp.
16. **Mode switch.** Does `off` 404 every public route? Does `preview` hide the nav? Does games
    being down hide the nav?
17. **Numbers.** Is every integer parameter bounded and NaN/Infinity-safe? The 2^53 rule on every
    column?
18. **Public lists.** No public list emits a full address; a test mirrors `test-public-leakage.js`.
19. **Growth.** Does every table have a retention rule or a bound?
20. **Moderators (D21).** Can a moderator act on an operator message or another moderator, approve or
    unmute themselves, shorten a mute, reach any `/internal/admin/` route, or learn a full address? Is
    removal (and a ban) effective on their next request? Is the password rule re-read per request? Can a
    stranger who mines to a moderator's address inherit the role (the aged-proof + password gates)?
21. **Nicknames (§19.16, Part 12).** Can any public response carry a nickname without its mask, or a
    pending / rejected one at all? Can a nickname imitate a badge ("Operator", "Mod"), an address, or
    another player's live name (case, separators, leet)? Can two live names share a matching form under
    a race? Can a stranger who mined briefly to an address name it (the aged-proof gate)? Is every admin
    write step-up at the pool? Does a ban end the name? Is the table bounded?

*Added 2026-10-03 by §19.17 (Part C0). R1 answers #22–#25 against C1–C4; R2 answers #26–#30 against C5–C7.*

22. **Option B is complete (D22).** No path creates an executing script, an event-handler attribute or an
    iframe from operator settings, an ad, or any fetched payload on a public page. Grep every
    `createElement('script')`, `innerHTML`, `insertAdjacentHTML`, `outerHTML`, `document.write`, `srcdoc` and
    `cloneScript` in `public_html` and `play/shell`; every remaining script creator is on an explicit
    allowlist (the provider-ID analytics loaders, the ads loader for image/link ads, the bubble loader) and
    builds its URL from a pattern-checked ID or a fixed path. A stored legacy code ad or custom HTML value
    never reaches a browser.
23. **Effective mode (D30).** No public games route, nav item or bubble is reachable in a state the launch
    gate forbids; `Go live` is step-up and audited; a pool that cannot reach games, and a games service that
    has not reached the pool for 10 min, both read `off`, as before. List every place that still reads the
    RAW pool mode and justify it.
24. **Name-checker parity (D5 + D27).** The pool's and the games' copies of the rule agree on the shared
    fixture; the matching form is applied before every uniqueness, ban and word check; the partial unique
    index, not the pre-check, is the guarantee under a race.
25. **Scunthorpe.** A short reserved or blocked word (`mod`, `pool`, `ass`) refuses no ordinary name, and a
    long one refuses none on the exceptions list — tested with the fixture's innocent list plus R1's own.
26. **Guest auth (D24).** No account enumeration through login, by timing (dummy scrypt) or wording (one
    `login_failed`; the ban answer only after the password); the only login-namespace oracle is sign-up,
    behind the PoW and the per-IP limit; a rename never answers "taken" for a login name. The per-name
    limiter cannot be armed by a stranger into a permanent lockout (failures only + the known-/24 bypass,
    as Part 4 #3). The scrypt cost is bounded globally (sign-up, login, password change and delete share
    one cap).
27. **PoW.** The challenge is single-use, expiring, bound to the /24 (/48) that fetched it; replay, another
    IP, an expired token, a forged HMAC and precomputation all fail; verification costs one HMAC + one hash.
28. **Guest Sybil.** What N cheap accounts can do — reports (excluded from auto-hold, D26), PvP Elo (the pair
    cap), events (`mining_*` kinds skip guests; `game_results` bounded by tickets), chat flooding (per-IP
    rates + the age gate), name squatting (idle deletion, the per-IP sign-up limit). Record as accepted
    whatever D1 makes harmless.
29. **Identity key.** A `g:` id never reaches the pool link, the activity sync, the moderator table or any
    money code; `names.label` covers every public name, guests and deleted guests included (the
    `test-names` scan); `login_name` reaches no response but its owner's `/me`.
30. **The bubble (D23).** `textContent` only; no session token or full address in the DOM; no polling while
    closed and signed out; nothing on exempt pages; the preview flag honoured. **Recorded as accepted:**
    the page's own analytics provider (GA4) runs on the origin and could in principle read a password typed
    into the bubble or ride a session — a trusted provider by the operator's choice (D22).

### 19.14 Status

Broken into 14 sessions (0–13) plus operator checkpoint A. The per-session plan is kept outside the
repo.

| Part | Scope | State |
|---|---|---|
| 0 | This section: decisions D1–D20, contract, schema, threat notes | **done 2026-09-27** (design only, no code). D18–D20 were asked and answered the same day. D20 replaced the first sketch's Block Hunt + Grin 2048 with chess (bot, then PvP correspondence), which reshaped §19.4, §19.7 and §19.8. |
| 1 | Games service skeleton + schema v1 (`play/server/`) | **done 2026-09-27, not VPS-tested.** Boots, validates its env, opens + migrates `grinium-games.db` to v1, serves `/play/api/health`, drains on SIGTERM. Nothing deploys it yet (Part 3). Games `npm test` 155/155 on Windows (2 skips: the 0600 file mode and SIGTERM, both POSIX-only). Deltas → §19.15 *Part 1*. |
| 2 | Pool link: `lib/games-link.js`, the `games` settings section, the branding flag, nav, tests (the only pool-side change; one pool restart at deploy) | **done 2026-09-27, not VPS-tested.** Three internal routes (above `express.json()`), the admin proxy with pool-side step-up, the 60 s probe, `games: {mode, chat}` in branding, the hidden Play nav item, Settings → Games. Pool `npm test` 2108 → 2282, 0 failed (NEW `test-games-link.js` 169, `test-public-leakage.js` +5). Deltas → §19.15 *Part 2*; as-built → impl §10.13. |
| 3 | Bash: `07_lib_pool_games.sh`, menu `P`, nginx snippet + glob include, backup, cleanup | **done 2026-09-27, not VPS-tested.** Menu `P` 1–8 as §19.12, the vhost's `/internal/` 404 + glob include, the games DB in `B) Backup` (separate restore question, also in Migrate IN) and in the daily cron wrapper, a games VACUUM under `C) Cron`, cleanup group 1b/1c, games deploy at the end of `9) Deploy new code`. `bash -n` clean; nothing can run on Windows, so every runtime claim is owed to checkpoint A. Deltas → §19.15 *Part 3*; as-built → impl §10.13 *Part 3*. |
| A | VPS checkpoint A (operator, mainnet, mode `off` → `preview`, impact budget 1–5) | **skipped by the operator 2026-09-27** (installs later). Part 4 was built without it, so nothing in Parts 1–4 has run on a box; the impact-budget checks are owed at that install. |
| 4 | Auth + sessions + activity sync + plays ledger | **done 2026-09-27, not VPS-tested.** Login (one pool proof on the real IP, a limiter chain before the pool), sessions (hashed token, 14 d hard, 20 per address), `/me` + `/sessions` + logout / logout-all, CSRF layer 3, the mode gate, the activity sync → plays, the ledger + hourly `verify()`. No pool code changed. Games `npm test` 155 → 318 (NEW `test-auth.js` 163), 0 failed. Deltas → §19.15 *Part 4*; as-built → impl §10.13 *Part 4*. |
| 5 | Match platform (registry, matches, bot mode) + chess `rules.js` (perft) + bot | **done 2026-09-27, not VPS-tested.** The registry (strict manifest, rules.js evaluated in a sandboxed `vm` context, smoke-tested at boot, reserved kinds refused), bot-mode matches (create / move with the bot's reply in the same transaction / resign / views / `mine`), settle + points under the daily cap, timeouts (lazy + a 5-min sweep), the 60-day bot-move purge; chess rules proved by perft, a seeded 3-level bot. PvP answers `mode_unavailable` until Part 10. Games `npm test` 318 → 451 (NEW `test-matches.js` 133), 0 failed. Deltas → §19.15 *Part 5*; as-built → impl §10.13 *Part 5*. |
| 6 | Shell `/play/` + chess frame: bot games playable in preview | **done 2026-09-27, not VPS-tested.** The page (pool header/footer, sign-in, Plays/Points placard, devices + log out everywhere, new bot game, My games, resign, offline/closed states), the sandboxed frame host and the chess frame (click-click + drag, promotion, keyboard). No inline script; no `innerHTML`. Pool: `public-shell.js` hrefs made site-absolute (a live bug on blog permalinks) and no ads on the games login. Deploy stamps the asset URLs. Games `npm test` 451 → 519 (NEW `test-shell.js` 68), pool 2290/2290; a headless-Edge probe 48/48 against the staged tree. Deltas → §19.15 *Part 6*; as-built → impl §10.13 *Part 6*. |
| 7 | Leaderboards + events + admin Events page | **done 2026-09-28, not VPS-tested.** Boards (points held, rating, wins / points per game + mode over the UTC day / ISO week / month / all), the three event kinds, the lifecycle with finalise-exactly-once, points + badge rewards, the `/internal/admin/*` guard (the first admin routes), the /play/ G-06 panel, the pool's Games → Events page. No pool backend code. Games `npm test` 519 → 630 (NEW `test-events.js` 101), pool 2290 → 2301; a headless-Edge probe 58/58 of the panel. Deltas → §19.15 *Part 7*; as-built → impl §10.13 *Part 7*. |
| 8 | Chat backend + moderation engine | **done 2026-09-28, not VPS-tested.** Read / post / report with every §19.10 gate (the recent-mining gate added to `auth.chatStatus`), body normalisation, auto-hold (words, links, addresses, reports), the change feed that keeps open pages current, retention, the operator's admin routes (messages, word list, mute / ban / purge / adjust, settings, mod log), ban revoking sessions, and **moderators (D21, new)**: schema v2 (`moderators`, `chat_words`) + `/play/api/mod/*`. No pool code; `FAST_WRITES` unchanged. Games `npm test` 630 → 803 (NEW `test-chat.js` 171). Deltas → §19.15 *Part 8*; as-built → impl §10.13 *Part 8*. |
| 9 | Chat UI + admin `games.html` / `games-chat.html` / `games-players.html` | **done 2026-09-28, not VPS-tested.** The /play/ G-07 chat panel (textContent only, the change feed, report, the moderator queue), live rules in the "How plays are earned" fold, and three admin pages + a shared `games-admin.js`; `games.html` is now the Games NAV parent. Games `npm test` 803 → 815, pool 2301 → 2322; a headless-Edge probe 58/58 of the chat panel. Deltas → §19.15 *Part 9*; as-built → impl §10.13 *Part 9*. |
| 10 | PvP correspondence chess: seeks, challenges, accept/decline, draw/abort/timeout, ratings, turn polling; the "add a game" checklist | **done 2026-09-28, not VPS-tested.** Seeks and direct challenges (72 h expiry, refunds exactly once), accept / decline / cancel with both-side caps, draw offer / accept / decline, abort + the ply < 2 resign-as-abort, timeouts, the rated pair cap + Elo (`lib/ratings.js`), admin void with the ratings recompute, `/lobby` + `/matches/turns`; the G-08 "Play a person" panel, board buttons from the view's `actions`, the 5 s board + 15/60 s turns polls, PvP boards; the Players page Void. No pool backend code, no schema change. Games `npm test` 815 → 918 (NEW `test-pvp.js` 90), pool 2322/2322; a headless-Edge probe of the PvP board + lobby. Deltas → §19.15 *Part 10*; as-built → impl §10.13 *Part 10*; the checklist → `play/README.md`. |
| 11 | Independent review of 1–10 against §19.13 (a separate, cold session) | **done 2026-09-28** (code review on Windows; nothing run on a VPS). All 20 threat notes answered against the code, the six mandatory probes run. Five findings fixed: a free bot game fed the wins boards and events (games), no global cap on the pool's internal routes against a compromised games process (pool, `games-link.js`), the login card never stated the "someone else can sign in as you" limit, a doc/code mismatch on mid-day settings changes, a menu misalignment. Two open for the operator: the rig password typed on the pool's account page (Part 6 #3) and the moderator-inheritance limit (#20). Games `npm test` 918 → 921, pool 2322 → 2330. Answers → §19.15 *Part 11 review*. |
| 12 | *(optional)* Approved nicknames (D19) | **done 2026-09-28, not VPS-tested.** Chosen by the operator. `lib/names.js` + schema v3 (`nicknames`): pre-moderated requests, one pending + one live per address, no two live names alike (a partial unique index), the chat gate minus the chat switch, 5 a day, 180-day retention; every public name through `names.label` → `Nick (mask)`; a ban ends the name; the `nicknames_enabled` switch; the /play/ Nickname fold (`play-names.js`) and the pool's Games → Nicknames page (all step-up, `FAST_WRITES` unchanged, no pool backend code). Games `npm test` 921 → 1010 (NEW `test-names.js` 78), pool 2330 → 2341. Contract → §19.16; deltas → §19.15 *Part 12*; as-built → impl §10.13 *Part 12*. |
| 13 | VPS acceptance B: mainnet `preview` → `on`; docs + memory fold | not run — **replaced by C9** (2026-10-03), which runs this list together with the v2 acceptance, so the box is tested once against the final code |
| C0 | v2 open community: decisions D22–D32, §19.17, the D8/D9/D10/D12/D19/D21 amendments, threat notes #22–#30 | **done 2026-10-03** (design only, no code). The operator's three answers: header group **Community**, donor names keep their charset, visible word **tickets**. O1 closed by decision D22 (code in C1). |
| C1 | Option B: remove the code-ad type and the custom-HTML sinks (pool front + back end) | **done 2026-10-04, not VPS-tested.** The code ad type and `custom_head_html` / `custom_body_html` deleted end to end (a stored legacy value is hidden, refused on write and never reaches a browser — not even the admin panel); the analytics loaders now pattern-check every value on write, on publish and in the browser; ad URLs must be a site path or http(s). Two adjacent holes closed (a GA id could break out of the init text; ad and provider URLs accepted `javascript:`). **One OPEN finding outside D22:** CMS page/post bodies are raw operator HTML on the origin — for the operator, before C7. Pool `npm test` 2536 → 2662 (NEW `test-operator-code-sinks.js` 92). Deltas → §19.15 *Part C1*; as-built → impl §10.13 *Part C1*. |
| C2 | Header group, default on, launch state (pool + games) | **done 2026-10-04, not VPS-tested.** `meta.launch` (fresh DB = preview) + `effectiveMode()` in both services (two copies, held together by a test); health carries `launch`, the pool's branding flag is the effective mode and a launch flip flushes it; `GET/POST /internal/admin/launch` (step-up, audited, idempotent) behind a Launch card on Games → Overview; pool defaults `on` + chat on (a saved row still wins — C9 checks the live one); Play inside the **Community** group with per-child gates and `applyNavGroups()`. Pool `npm test` 2662 → 2693, games 1010 → 1060 (NEW `test-launch.js` 50). Deltas → §19.15 *Part C2*; as-built → impl §10.13 *Part C2*. |
| C3 | Nickname rule v2 + the pool-owned blocked-word list; schema v4 (games + pool) | **done 2026-10-04, not VPS-tested.** `name-rule.js` in both services (identical code, one shared fixture: 75 cases + 40 innocent + 40 adversarial); nicknames live at once with a 7-day change cooldown and a 10/day refused-attempt cap; generic `name_not_allowed` / `name_unavailable`; schema v4 (`banned_names`, four `players` columns, Part 12 rows re-checked in the migration); admin list/search, remove, ban name, unban, block/unblock (step-up), a rule hint on live rows; moderator **Remove name** keyed by a chat message; pool `names.blocked_words` (Settings → Names, step-up) sent in `/internal/games/config` with `pool_name`, persisted by the games. Pool `npm test` 2693 → 2719 (NEW `test-name-rule.js` 20), games 1060 → 1111. Deltas → §19.15 *Part C3*; as-built → impl §10.13 *Part C3*. |
| C4 | Donor names auto-checked (pool; banners untouched) | **done 2026-10-04, not VPS-tested.** The shared rule gained a `donor` shape option (both copies, one fixture: +37 cases (34 donor-shape), +30 innocent, +28 adversarial); a donor name is checked and live at once, one change per 7 days, generic `name_not_allowed` / `name_unavailable` answered only after both proofs; `banned_donor_names` + Live / Removed / Banned lists on Donors; the review queue holds banners only; `donor_name_blocklist` retired into `names.blocked_words` (carried once); pending names migrated at start. Pool `npm test` 2719 → 2795, games 1111 → 1114. Deltas → §19.15 *Part C4* (a separated word counts as whole — R1 to judge). |
| R1 | Independent review of C1–C4 against #22–#25 (a cold session) | **done 2026-10-04** (code review + one-shot local probes on Windows; nothing run on a VPS). #23, #24, #25 confirmed; #22 confirmed for D22's own sinks, **not complete while D22-4 (CMS page/post bodies) is open — an operator decision owed before C7**. The nav matrix rendered 12/12 at 1280 + 390 px in headless Edge. Two fixes in the shared name rule (both copies + fixture): the pool's name is reserved whatever punctuation, accents or emoji it carries (R1-1), and two Scunthorpe false refusals are gone (R1-2); residues accepted (R1-3). Every C1–C4 departure judged and accepted. Fixture 112 → 124 cases, innocent 40 → 82, adversarial 40 → 79; pool `npm test` 2795/2795, games 1114/1114. Answers → §19.15 *R1 review*. |
| C5 | Guest accounts backend: PoW sign-up, guest login, tickets top-up, guest chat gate, identity fences; schema v5; the sign-up nginx zone | **done 2026-10-04, not VPS-tested.** NEW `lib/guests.js` (stateless HMAC PoW, sign-up in the §19.17.3 order, guest login on its own route `/play/api/login/guest`, password change, delete, the idle job, one scrypt cap) and `lib/tickets.js` (the daily SET, ledger rows `gd:<day>`); schema v5 (`guests`, `guest_signups` — a separate sign-up log so a delete never frees a slot — three `players` columns, the `sessions` rebuild); the guest chat gate (live account age, own switch, 15 s / 10 h, links always held, guest reports not counted); `Nick · guest` / `Guest-XXXX` / `deleted guest`; fences in pool-link, the activity sync, moderators and mining events; admin player routes take `g.<16>`, NEW guest delete; `plays_balance_cap` 999; nginx `…_gamesignup` 6 r/m. Games `npm test` 1114 → 1276 (NEW `test-guests.js` 151), pool 2795 → 2797. Deltas + the #26–#29 self-review → §19.15 *Part C5*; as-built → impl §10.13 *Part C5*. |
| C6 | Guest UI on /play/ (sign-in tabs, sign-up + PoW, account box, "tickets") | **done 2026-10-04, not VPS-tested.** NEW `play/shell/js/play-guest.js` + `play-pow.js` (plain-JS SHA-256 midstate solver — WebCrypto measured too slow, §19.15 *Part C6* #1); Miner · Guest tabs with sign-up inside the Guest tab and `/play/#signup`; the Guest account box (password change, typed delete); "tickets" on every visible surface + three games sentences; the guest chat gates; `PlayApi.rules()` shared. Games 1316/1316, pool 2797/2797, headless-Edge probe 95/95. Owed: the PoW timed on a phone (C9); the bubble's storage hints are C7's |
| C7 | The floating chat bubble (games tree) + the pool loader | **done 2026-10-04, not VPS-tested.** First, the operator's D22-4 answer: **sandbox** the CMS page/post bodies (NEW pool `js/cms-frame.js`, a `srcdoc` frame with no `allow-scripts`; audit D22-4 → fixed). Then the bubble: NEW games `play-chat-core.js` (the one chat client — the /play/ panel rebuilt on it), `chat-bubble.js` + `.css`; the loader in the pool's `branding.js`; the shell writes the two hints; `rules` carries the effective mode. Games 1356/1356, pool 2829/2829, headless-Edge probe 259/259. No nginx change (estimate in #12). Owed: a real phone, Search Console on a framed post (C9) |
| R2 | Independent review of C5–C7 against #26–#30 + whole-feature regression (a cold session) | **done 2026-10-04** (code review + one-shot local probes on Windows — a harness against the real games app 34/34, headless Edge 17/17 + the CMS-frame attack 3/3; nothing run on a VPS). #26–#30 confirmed (#26 after R2-1), **#22 now complete** (the D22-4 sandbox attacked in Edge: no body markup ran, with two controls), money untouched (no money-path file changed). **R2-1 (Medium) fixed:** the guest per-name failure budget and the per-account current-password lockout could be raced by a parallel burst (60 of 60 guesses against a budget of 20) — the token is now reserved before the scrypt await (`ratelimit.js` `refund`) and the current-password check is single-flight. R2-2: residues accepted. Games 1356 → 1362, pool 2829 → 2829. §19.15 *R2 review*; audit roll-up rows R2-1, R2-2 |
| C9 | VPS acceptance on MAINNET (old Part 13's list + v2), O2 decided, docs + memory fold | not run |

**Parts 1–10 are built and Part 11 has reviewed them; Part 12 was built after the review (so it has had only its own self-review, §19.15 *Part 12*); nothing in §19 is VPS-verified.** Checkpoint A was skipped by the operator (installs later). Part 12 (nicknames) is built too (2026-09-28); Part 13 (the VPS acceptance run) is next. The moderation tools exist, so chat
may be switched on in `preview` for acceptance; mode `on` still waits for Part 13's acceptance run.
*(Since C2 the pool's mode defaults to `on` and the games' launch state holds a fresh install in preview
until Go live (§19.17.2) — so "on waits for acceptance" now means: do not click Go live before C9.)*
**Since 2026-10-03 the v2 rows C0–C9 (§19.17) extend this table, and C9 replaces Part 13**; the order is
C0 → C1 → C2 → C3 → C4 → R1 → C5 → C6 → C7 → R2 → C9.

### 19.15 Build deltas

Recorded by the build session of each part, against the section it changes. Part 11's review
answers go here too.

**Part 1 — games service skeleton (2026-09-27, not VPS-tested).** Code in
`web/07_mining_pool_public/play/server/` (+ `play/README.md`). No §19.4 schema change: the
suite runs §19.4's SQL block on its own and requires the migration to produce exactly the same
35 tables and indexes. **So §19.4's SQL block is now test-bound.** A schema change is a new
migration *and* an edit to that block, in the same change.

1. **Layout (§19 Layout / plan).** Two files beyond the plan's list: `lib/app.js` (routes, the
   server, `listen`, `shutdown`), so tests use the real pieces without booting, and `lib/log.js`
   (one-line records; newlines in a message are flattened so no message can forge a second log
   record). `index.js` only wires them to the process.
2. **Exit code 78 (EX_CONFIG) on a bad config**, 1 on any other boot failure. Part 3's unit
   should set `RestartPreventExitStatus=78`: a restart cannot fix a config, and without it
   systemd loops on one.
3. **Config is stricter than §19.12 implied** (`lib/config.js`):
   - `GAMES_NET` has **no default**.
   - An unknown `GAMES_*` variable refuses the start, so a typo cannot quietly leave a
     default in force. A later part that adds a variable adds it to `KNOWN_GAMES_KEYS`, and
     Part 3's unit must set only known keys.
   - `POOL_INTERNAL_URL` must be `http://127.0.0.1:<port>` or `http://[::1]:<port>`, with an
     explicit port and nothing after it. `localhost` is refused because it is a name, and the
     link secret will be sent to this URL (Part 4).
   - `GAMES_DB` must end in `.db` and must not resolve inside the code dir or the games dir.
     That turns D3's rsync trap into a start refusal.
   - `GAMES_PORT` must differ from the pool's port.
   - The listen host is not configurable at all.
4. **DB file modes (D3).** The file is created 0600 *before* SQLite opens it (SQLite gives
   `-wal`/`-shm` the main file's mode), and then chmod'ed as the pool does. That closes the
   create-then-chmod window. The mode check is skipped on Windows, where chmod does nothing,
   and is owed on the VPS.
5. **Migrations (§19.4 rules).** Idempotence comes from the version gate plus one transaction
   per migration. The SQL is plain `CREATE`, not `IF NOT EXISTS`, so a leftover table with the
   wrong shape fails loudly instead of being adopted. A DB whose `schema_version` is newer than
   the build is refused (no silent downgrade). `meta.net` is checked **before** migrating, so
   a future migration never runs against the other network's file.
6. **`transaction()`** starts the outermost level with `BEGIN IMMEDIATE` (§19.8 needs this for
   every write), nests as `SAVEPOINT`, and **refuses an async callback**. With one
   `DatabaseSync` connection, an `await` inside a transaction would pull other requests'
   statements into it.
7. **HTTP rules for every route (`lib/http.js`).**
   - **Paths:** matched on the raw path, with no percent-decoding and no dot-segment
     resolution. A `:param` segment is `[A-Za-z0-9_.~-]` and never starts with a dot.
   - **Bodies:** **every non-GET request needs `Content-Type: application/json`**, including
     `logout`, whose client must send `{}` (the CSRF layer of §19.5). The body is capped at
     16 KB unless the route sets its own cap. `Content-Length` over the cap gets 413 before a
     byte is read. A streamed overflow gets 413 + `Connection: close`, and the rest of that
     body is drained, not left unread: closing a socket with unread input can reset the
     connection before the client sees the 413. nginx's body cap bounds the drain.
   - **Headers:** JSON responses also carry `Content-Security-Policy: default-src 'none';
     frame-ancestors 'none'`, beside nosniff + no-store.
   - **HEAD** is answered on GET routes, for Part 3's `curl -sI` checks.
   - **Request ids:** a well-formed incoming `X-Request-Id` (the admin proxy's) is kept;
     anything else is replaced.
8. **Client IP.** `X-Real-IP` is trusted only from exactly `127.0.0.1`, `::1` or
   `::ffff:127.0.0.1`, not from all of 127/8. A malformed header from loopback falls back to
   the peer address.
9. **Cookies (for Part 4).** A cookie name sent twice parses as `null`, which means no
   session. The reason is cookie tossing: a sibling subdomain can plant a second `grin_play`,
   and "first one wins" would let it choose the session. The `__Host-` prefix cannot be used,
   because it requires `Path=/` and §19.5 uses `Path=/play/`.
10. **Health (§19.3).** It reads `schema_version` live, so a DB that stopped answering returns
    503 `db_unavailable` instead of a cached "fine".
11. **Maintenance (§19.12).** Both tiers (5 min and hourly) already exist, not just the hourly
    scaffold. Every job runs through one serial queue, so two tiers never interleave at an
    `await`, and a tier that comes due while already queued is coalesced. Timers are unref'd.
    No jobs are registered yet.
12. **Node 24 prints `ExperimentalWarning: SQLite …` once at boot.** It is harmless. The test
    runner suppresses it with `--disable-warning=ExperimentalWarning`; Part 3 decides whether
    the unit does too.

**Part 2 — pool link (2026-09-27, not VPS-tested).** Code in NEW `back-end-pool/lib/games-link.js`
plus mount lines in `index.js`; as-built notes in impl §10.13. What changed against §19.3, §19.11
and the plan:

1. **`games_port` and `games_link_secret_file` are pool.json keys, not pool settings** (§19.3
   table edited). The admin proxy sends the link secret and admin headers to `games_port`. As a
   panel setting, a stolen admin session could have pointed that at any localhost service (the
   wallet owner API on 3420, say), and an admin-editable file path would make the pool read any
   file it can. `lib/config.js` supplies the per-network defaults. Part 3 writes them with
   `pool_write_conf_key` only if absent. **A bad value disables the link and logs one line; it never
   fails the pool's boot**, because nothing about the games may endanger mining.
2. **Mounted before `express.json()`, not just before the rate limiters.** Otherwise express.json
   would parse up to 100 KB for an unauthenticated caller before the secret check, against §19.3's
   "secret first". The lib reads its own body with the 2 KB cap. The setup therefore has two phases:
   `createGamesLink()` + `app.use()` at the top of `index.js`, `attach()` in `setupRoutes`.
3. **A third guard on `/internal/*`:** any `X-Forwarded-For` / `X-Real-IP`, or a non-loopback
   socket, gets 404 before the secret is looked at. nginx always adds XFF, so a request that
   reached `/internal/` through any proxy location cannot even learn whether the link is configured.
   **Part 4's `pool-link.js` must send neither header to the pool.**
4. **verify-proof refuses a loopback or unspecified `client_ip`** (400 `client_ip`). If games ever
   forwards `127.0.0.1`, its X-Real-IP chain is broken and every player would share one throttle
   bucket (D7); refusing makes that loud. It also refuses **unknown body keys** (400 naming the
   key). Proof results are **HTTP 200** either way: `{ok:true, method, slot, age_seconds}` or
   `{ok:false, reason}`. Transport and shape errors carry `error` (plus `field`), never `reason`,
   so Part 4 can tell "the proof failed" from "the call failed". 413 `payload_too_large` and 415
   `unsupported_media_type` join §19.3's error codes.
5. **Success envelopes carry `ok:true`** on config and activity too (§19.3 listed bare fields).
   Activity 400s name `field`: `from` / `to` / `window` or the unknown key. Repeated params,
   signs, decimals, `1e3` and `0x…` are refused.
6. **Activity SQL is pinned with `INDEXED BY idx_hashrate_time`.** The planner already chooses that
   index without stats (checked 2026-09-27: `SEARCH … (recorded_at>? AND recorded_at<?)` + a temp
   b-tree for the GROUP BY). The pin turns a future dropped or renamed index into an error instead
   of a silent scan on the stratum process.
7. **Link secret file format:** surrounding whitespace is trimmed (a trailing newline is not part
   of it), files over 4 KB are ignored, and the file is re-stat'ed at most once a second. So a
   rotation is picked up within about 1 s, not strictly "on the next call". **Part 4 must trim the
   same way.**
8. **`config` answers 503 `settings_unavailable`** when the settings cannot be read, never a
   guessed `off`, so the games service's "keep the last known mode ≤ 10 min" (§19.2) can work.
9. **The step-up list is written as the FAST list, fail-closed** (§19.11 now lists the six exact
   paths). Games-side route names in Parts 7–9 are bound by it. The pool-owned Settings → Games save
   is step-up (`'games'` added to `STEP_UP_SETTINGS_SECTIONS`, per §19.11's "every games-settings
   write"). Admin proxy methods are GET/POST/PUT/PATCH/DELETE (others 405). The proxied path is
   checked raw: games' `:param` charset per segment, no `%`, no dot-leading segment, ≤ 256 chars.
   Upstream responses are capped at 2 MB.
10. **Probe health also requires `net` to equal the pool's network**, so a testnet games service
    answering on the mainnet port is unhealthy. A health flip calls `invalidateBranding`, so the nav
    follows within one branding fetch instead of the 60 s memo. The pool reads mode `off` until the
    first probe answers (it runs at attach, before `listen`).
11. **Branding `games.chat`** is `false` whenever the published mode is `off`, whatever
    `chat_enabled` says.
12. **Admin UI:** mode is a `<select>`, not radios, because the settings harvester sends every
    input's `id` and has no radio handling (memory `project_pool_admin_settings_form`). The health
    line reads a new pool-only route, `GET /api/admin/games-link` (secureAdmin, not proxied). It
    returns the switch state, `public_mode`, the port, the link file path, `link_configured` and the
    probe, never the secret.
13. **Implementation doc section is §10.13**, not the plan's §10.10 (§10.10–§10.12 were taken by
    then).

**Part 3 — operator side (2026-09-27, not VPS-tested).** NEW `scripts/lib/07_lib_pool_games.sh`
plus hooks in the pool script, `07_lib_pool_backup.sh` and `07_lib_pool_migrate.sh`; as built in
impl §10.13 *Part 3*. What changed against §19.3, §19.12, D16 and D18:

1. **The unit writes to the data dir only.** D16 said "the data dir + log dir". stdout/stderr go to
   the log through `StandardOutput=append:`, which systemd opens as root before dropping to
   `grinplay`, so the service never needs write access to `/opt/grin/logs`, and does not get it.
2. **Hardening beyond D16:** `PrivateDevices`, `ProtectKernelTunables`, `ProtectKernelModules`,
   `ProtectControlGroups`, `RestrictSUIDSGID`, `LockPersonality`. All are safe for Node. Not
   `MemoryDenyWriteExecute`, which breaks V8's JIT. No `Requires=`/`BindsTo=` on the pool unit in
   either direction. Part 1's open items are closed here: `RestartPreventExitStatus=78` (#2), only
   known `GAMES_*` keys are set (#3), and `--disable-warning=ExperimentalWarning` on `ExecStart`
   (#12).
3. **pool.json is the source of truth for the port and the link path.** The installer writes
   `games_port` / `games_link_secret_file` only if absent (as §19.3 says), and when they ARE present
   the unit follows them rather than the lib's defaults. A value the pool would reject (Part 2 #1)
   stops the install with the reason. `games_port` joined `pool_write_conf_key`'s numeric set, so it
   is stored as a JSON number.
4. **Link secret: temp file + rename, not `install`.** `openssl rand -base64 48` is redirected into
   a `mktemp` file in the same directory under `umask 077`, which gets `grinplay:grinpool 0440`
   before the rename. The secret never enters argv or a shell variable. P → 5 and P → 7 read it
   inside `node`, given only the path. The installer also adds `o+x` to `/opt/grin/conf`: `grinplay`
   must traverse it to reach its file. `mkdir`'s default 755 usually gives that already, but nothing
   in the toolkit guaranteed it.
5. **Deploy stages both trees, then one `rsync --delete` each.** A second rsync into
   `<code>/games/` after the first would have deleted and recreated it on every deploy. Game folder
   names must match `^[a-z0-9][a-z0-9_-]{0,31}$`, or they are skipped. A stray `node_modules` in
   `server/` is dropped. `pgs_deploy_code` refuses outright if the data dir ever sits inside a deploy
   target, which is D3 enforced where it could break.
6. **`version.js` is `window.GRIN_PLAY_VERSION = "<12 hex>"`**, a sha256 over both staged trees.
   **Part 6 must load `/play/version.js` and use it as its cache-bust query.**
7. **nginx, three refinements.**
   - The frame CSP ends with `sandbox allow-scripts`. That repeats the iframe attribute for a frame
     opened directly in a tab, where no attribute applies.
   - `Cache-Control: no-cache` is on every file under `/play/` and `/play/games/`, not only
     `*.html`, the same as the pool's own `location /`. It covers `version.js` itself.
   - The shell CSP keeps the page CSP's Google Fonts hosts, so the pool's fonts render. It drops
     every analytics host and `'unsafe-inline'`.
   Both static locations use the pool's `<svc>_static` zone. **Frames must use classic scripts**:
   a module script fetched from an opaque origin needs CORS, and this location sends none (Part 6).
8. **The route check goes through the local listener** (`curl --resolve <domain>:443:127.0.0.1`), so
   Cloudflare cannot answer in the origin's place. It also checks `/internal/games/config`, the
   exact path a leak would expose, not only `/internal/x`.
9. **A vhost written before Part 3 has no include.** P → 3 detects that and offers to regenerate
   it through `4) Setup nginx`, which is an nginx reload, not a pool restart. If the operator
   declines, the snippet stays on disk, unused and harmless.
10. **Restore (D18) happens after the main extraction, never inside it.** `_pbk_restore_extract`
    excludes the games DB. Both `pbk_restore` and Migrate IN then call
    `pgs_restore_db_from_archive`. A plain extraction would have written under a running games
    service and next to a stale `-wal`, which SQLite would then replay onto the restored file. The
    function stops games, moves the old DB and its sidecars aside as
    `grinium-games.db.pre-restore[-wal|-shm]` (one generation kept), and places the file. An EOF on
    the `[Y/n]` declines. The question is skipped after a failed pool extraction.
11. **Snapshots use the backup API with no `cp` fallback**, unlike `gbe_snapshot_db` for `pool.db`.
    For a best-effort extra, "no games data" is better than "maybe-torn games data". `-wal`/`-shm`
    created by the root-side open are chowned back to `grinplay`. **The daily cron wrapper includes
    the games DB too**, and P → 1 regenerates the wrapper when a schedule is on, because the wrapper
    is written once and would otherwise never learn about the games.
12. **Weekly games VACUUM: Sunday 03:30 UTC**, half an hour after the pool's, run as `grinplay` via
    `runuser`, so the rewritten file and any sidecar stay the service's. `pgs_status` reads
    `schema_version` the same way, as `grinplay`, for the same reason (the pool's §J16-8 trap).
13. **Cleanup prompts:** group 1b (everything but the DB) is `[Y/n]` like its neighbours. 1c (the DB)
    is **`[y/N]`, default keep**: it is player history, not rebuildable state. Uninstall (P → 8)
    likewise keeps the DB unless confirmed, and keeps the `grinplay` user and the pool.json keys.
    Both remove the link file; the pool then answers `link_not_configured` and the probe hides the
    nav.

**Part 4 — login, sessions, activity sync, plays ledger (2026-09-27, not VPS-tested).** Games service
only (`play/server/lib/`); no pool code changed. Built with checkpoint A **skipped by the operator**.
As built in impl §10.13 *Part 4*. What changed against §19.2, §19.5, §19.6 and the plan:

1. **Mode `off` answers 404 to login too.** The plan's Part 4 said "every public route except
   health/login"; D12 says every public route except health, and §19 wins. A login that works while
   the operator believes the games are off would be a proof oracle nobody is watching.
2. **Modules beyond the plan's list:** `settings.js` (the games-owned `settings` table behind a typed
   spec; a stored value that no longer validates reads as the default with one warning; Part 9 writes
   through it), `mode.js` (the mode cache), `auth.js` (the routes), `mask.js` (the pool's `maskAddr`,
   copied). `app.js publicRoute()` applies the mode gate and CSRF layer 3 to every public route.
   **Admin routes (Parts 7–9) must not use it:** they are secret-gated and must work while the games
   are off, so the operator can prepare them.
3. **The per-address limit counts FAILURES only, and a known IP passes it.** A limit on every attempt
   at an address is a switch any stranger can flip to lock the owner out (the pool's §J3-3 lesson).
   So: a per-IP bucket (10 attempts, refilling 1/min); per-IP (10) and per-(address, IP) (5) failure
   lockouts, 5 min doubling to 6 h, set below the pool's 20 / 8 so ours trip first; a per-address
   **failure** budget (20, refilling 1 per 3 min) that an IP whose /24 (/48) had a session for that
   address in the last 30 days skips. Only `no_match` counts, exactly as in the pool: every other
   reason is decided before any scrypt. All of it is in memory and forgotten on restart; the pool's
   own throttles, keyed on the real IP, are the real stop.
4. **Dead sessions are kept 30 days**, not purged sooner, because the known-IP check reads them.
5. **Login answers.** 401 `login_failed` with `reason` and `hint` (the account page's sentence for
   it); `too_many_attempts` and every local limit → 429 with `Retry-After`; `lookup_failed` and any
   link error → 503 `pool_unavailable`; an unknown reason is shown as `no_match`. A loopback client
   IP (no `X-Real-IP`) → 400 `client_ip` without calling the pool, the same refusal the pool makes.
6. **CSRF layer 3, exactly:** the expected origin is `https://` + the `Host` nginx forwards
   (`X-Forwarded-Proto` believed from a loopback peer only). `Origin: null` is refused, and so is any
   `Sec-Fetch-Site` other than `same-origin` / `none`, which also refuses a sibling subdomain. An
   absent `Origin` passes: curl and the admin proxy send none, and a browser always sends one on a
   cross-origin POST.
7. **Chat status.** `chat_ok_after` is fixed at login, but the password-only switch is **re-read on
   every `/me`**, so turning it on mid-incident closes chat to IP-proof sessions already open. A later
   raise of `chat_min_proof_age` is not retroactive. Reason codes: `chat_off`, `muted`,
   `anchor_proof`, `password_required`, `proof_too_new` (+ `available_at`). Part 8 adds the
   recent-mining gate in `auth.chatStatus`.
8. **Session metadata.** `ua_hint` is a coarse "Browser on OS" parsed from the User-Agent; the raw UA
   is never stored (attacker-chosen text, and a fingerprint).
9. **Activity sync.** The first sync starts at the current UTC midnight, so today's minutes count at
   launch (≤ 24 windows, one tick). An outage past 7 days is **one** skipped row, not one per hour. A
   pool 400 on `from` (clock skew at the lookback edge) skips that window instead of retrying it
   forever. Per-address seconds are clamped to the window length. The sync runs in every mode,
   `off` included (one indexed pool query per 5 min, and plays exist when the games switch on); with
   no link secret it is a no-op.
10. **"A change never recomputes the past", made precise.** `due` uses the whole current UTC day's
    seconds (§19.6's formula), so a lower `minutes_per_play` set at noon also re-rates the morning's
    minutes from the next window on. Nothing is ever clawed back, credited windows are never
    rewritten, and earlier days are untouched.
11. **Ledger.** `post()` is the only writer of `players.plays` / `points`. `reason` must be one of
    §19.4's list; `ref` matches `[A-Za-z0-9:_.-]{1,64}`; `|delta| ≤ 10^9`. `verify()` also reports
    ledger sums for an address with no `players` row.
12. **Jobs registered:** 5 m `activity_sync`; 1 h `session_purge`, `limiter_sweep`, `ledger_verify`.
13. **Growth (§19.13 #19): the ledger has no retention yet.** About 24 rows per active address per day
    from mining, plus match rows from Part 5, and `verify()` sums the whole table hourly. That is fine at
    this community's size; Part 11 must decide on a rollup before it matters.
14. **Ban revocation at the moment a ban is applied is Part 8/9's.** Until then, a session lookup
    already refuses a banned player, so a ban takes effect on the next request.

**Part 5 — match platform, chess, bot (2026-09-27, not VPS-tested).** Games service only: NEW
`play/server/lib/{registry,matches}.js`, NEW `play/games/chess/{manifest.json,rules.js}`, wiring in
`lib/app.js`; no pool code. As built in impl §10.13 *Part 5*. What changed against §19.4, §19.6–§19.8
and the plan:

1. **rules.js is evaluated, not `require()`d.** The registry runs it in its own `vm` context: no
   `require`, `process`, `console` or timers, no `Date`, a `Math.random` that throws, string eval and
   WASM codegen refused, and a 1 s limit on the load. That turns §19.7's "pure, no I/O, no `Date`, no
   `Math.random`" from a convention into a check. It is **not** a security boundary: rules.js is our own
   reviewed code. The registry also smoke-tests each game on its start position (`initial`, `toMove`,
   `legal` against `move_pattern`, `status`, one `apply`), so a broken game is skipped at boot, not
   found by the first player. The folder rule is §19.7's `^[a-z0-9-]{2,32}$`, stricter than Part 3's
   deploy regex (which also takes `_` and one-character names). A folder the deploy copies but the
   registry refuses is skipped with a log line.
2. **A free bot game pays no points** (the plan's self-review question b). With `bot_play_cost` 0 a
   level-1 bot would be a points tap that needs no mining at all, which bypasses D10. The cost is
   recorded in the match (`params_json.cost`, a key §19.4's comment did not list), so a later settings
   change never alters what an existing match refunds or pays.
3. **Point values are manifest values, not settings.** §19.6's `bot_points[level]`, `pvp_win_points`
   and `pvp_draw_points` are the game's `points.bot`, `points.pvp_win` and `points.pvp_draw`. A game
   defines what its own levels are worth, so changing them is a deploy. The games-owned settings added
   are `bot_play_cost` (1, range 0–10) and `points_daily_cap` (100, range 0–100 000). Part 9 may add
   per-game overrides if the operator wants them in the panel.
4. **Unknown body keys are REFUSED** (400, `field: 'body'`), not ignored as the plan's test list said.
   That matches login and the pool's verify-proof, and a forged `position`, `result`, `score` or
   `points` can never be half-accepted.
5. **The move rate is per ADDRESS** (burst 3, 1/s), not per session. With 20 sessions per address, a
   per-session limit would allow 20 bot searches a second.
6. **The deadline check comes before the turn and ply checks** (§19.8 listed it third). A timed-out
   match is finalised whoever asks, and the finalisation is committed before the 409 `timeout`.
   Timeouts apply to bot matches too: the human is always the side to move, and `ply < 2` aborts and
   refunds. Creating a bot game over an expired active one finalises the old one first, so an
   abandoned game never blocks the slot.
7. **The platform enforces `max_plies` for every game** (a draw with reason `max_plies`), on top of
   chess's own check in `rules.status`. A game whose rules forget it still ends.
8. **Every move replays the match.** The repetition history is rebuilt from `match_moves` through
   `rules.apply` on each move. The replay doubles as an integrity check: it must land exactly on the
   stored position, or the request answers 500 `game_error` and the match is left alone. Chess's
   `apply` makes only the one matching pseudo-legal move for this reason, not the whole legal list.
   **Worst-case CPU of one move request** (self-review c): a 409-ply replay plus a level-3 reply took
   about 13 ms on the Windows dev box.
9. **The bot's node budget is a backstop.** 2-ply alpha-beta never came near 20 000 nodes in testing:
   1 051 at most, a 32-queen position included. The cut-off is proved with a tests-only budget
   argument (`botStats`'s fifth argument; `bot()` always uses the constant). Level 3 scores a leaf
   that is in check with no legal move as mate, so it never walks into a mate in 1. **The match seed is
   never sent to a client**: with it, a player could replay the bot's tie-breaks offline.
10. **`game_version` is recorded, not enforced.** A deploy that bumps a game's version continues active
    matches under the new rules; a version check would strand every one of them. If a game's folder
    disappears, move and resign answer 503 `unknown_game`, and its timeouts abort and refund, because
    only the rules know whose turn it was.
11. **Retention (§19.8).** The hourly bot-move purge walks match ids upward from a watermark in `meta`
    (`bot_moves_purged_through`). The watermark stops at the first bot match that is not yet eligible,
    so none is ever skipped: a long-running bot game only delays the purge of later ones. A purged match
    still reads, with `moves: []`.
12. **Routes and shapes for Part 6.**
    - A new route, `GET /play/api/games`: the registry's public summary.
    - `GET /matches/:id` needs no session. A spectator gets `you: null` and no `legal` list.
    - `colour` is `'seat1'` | `'seat2'` | `'random'`; for chess, seat1 is white.
    - Error codes: `unknown_game` 404 · `mode_unavailable` 400 (PvP, until Part 10) · `active_match`
      409 (+ `match_id`) · `not_your_match` 403 · `not_your_turn` 403 · `not_active` 409 · `stale`
      409 · `timeout` 409 · `illegal_move` 400 · `game_error` 500 · `no_plays` 409.
    - The match view: `{ id, game_id, game_version, mode, state, labels{1,2}, you, to_move, your_turn,
      ply, position, last_move, legal, status{over,result,reason}, bot_level, move_seconds,
      turn_deadline, created_at, started_at, finished_at, last_move_at, since_ply, moves }`.
13. **Jobs registered:** 5 m `match_timeouts` (at most 200 per tick, oldest deadline first); 1 h
    `bot_moves_purge` (at most 500 match rows per run).

**Part 6 — the `/play/` shell + the chess frame (2026-09-27, not VPS-tested).** NEW `play/shell/**` and
`play/games/chess/frame/**`; one pool static file (`public_html/js/public-shell.js`) and one hunk of
`07_lib_pool_games.sh`; no games-service or pool-backend code. As built in impl §10.13 *Part 6*. What
changed against §19.7, D4, D13, §19.15 *Part 3* #6 and the plan:

1. **Cache-bust = a deploy-time stamp, not a JS loader.** Every own `<script>`/`<link>` in the shell
   and in a frame is written `?v=__GRIN_PLAY_VERSION__`; `_pgs_stage_trees` replaces it in every staged
   `*.html` with the version.js stamp, after the hash. A static tag stays parser-inserted — ordered, and
   render-blocking for CSS — which a loader reading `version.js` at runtime could not give. The shell
   still loads `/play/version.js` (Part 3 #6): `frame-host.js` reads `GRIN_PLAY_VERSION` for the frame
   `src`. The pool's own `/css` + `/js` stay unversioned, as on every pool page.
2. **The pool chrome runs on `/play/` unchanged in behaviour:** `public-shell.js` → `public-theme.js` →
   `branding.js`, all under the shell CSP. `branding.js` is clean there because the page sets
   `<html data-untrusted-html="exempt">` — a rig password is typed in the login card, so the §J1-1
   rule applies: no analytics, no operator raw HTML. Its `<style>` injections are covered by the CSP's
   `style-src 'unsafe-inline'`, its JSON-LD block is data, not script.
3. **Pool change 1: no ads on an exempt page.** A `code` ad is operator HTML/JS that `ads.js` re-creates
   as executing scripts — the same sink. `public-shell.js` now renders no ad slot and never loads
   `ads.js` when the page opts out. *Noticed, not changed:* `account-settings.html` takes the same rig
   password and does NOT opt out, so it still runs analytics, custom HTML and code ads. Pool
   `CREDENTIAL_PAGES` is `['login']`. For Part 11 / the security audit to decide.
4. **Pool change 2: every chrome href is site-absolute** (`abs()`), and the active item is compared by
   path. A relative `index.html` resolved to `/play/index.html` here — and to `/blog/index.html` on every
   blog permalink (`post.html` is served at `/blog/<slug>` with no `<base>`), where the header and
   footer links have been 404s since the permalinks shipped. A `<base href="/">` was rejected: it turns
   the skip link's `#main` into a navigation to the home page.
5. **In-flight moves are the frame's job, not a protocol message.** After posting a `move` the frame
   draws it provisionally (its copy of `rules.apply`) and takes no input until the next `state`, which
   is the server's board either way. The shell drops a move that arrives while a request is in flight;
   no "busy" state is ever posted (a state for the old position would snap the piece back).
6. **No reset on the iframe's `load` event.** The frame's `ready` is posted while its scripts run and
   can be handled before the parent sees `load`; a reset there would strand the frame. A reloaded frame
   just sends `ready` again, which re-sends the held theme + state.
7. **What counts as "offline"** (`play-api.js`): a network error or 20 s timeout, any response whose
   Content-Type is not JSON (a 200 included), a body with no boolean `ok`, and 503
   `shutting_down`/`db_unavailable`. A 404 `not_found` on `/me` is mode `off` → "Games are closed"; 401 →
   sign in; 403 `banned` → signed out with the server's sentence. A background `/me` refresh ignores an
   offline blip rather than blanking the page.
8. **Frame messages are exact-key.** Inbound to the shell: `ready {protocol:1}` and `move {move}` with no
   other keys, a same-realm plain object, from the frame's `contentWindow` only. `sendState` rebuilds
   §19.7's fields from the match view, so a token, full address or seed cannot ride along by accident;
   `legal` is omitted, not `null`, when it is not the viewer's turn. The frame validates `state` the same
   way (FEN shape, move pattern, ≤ 512 legal moves, labels ≤ 64 chars).
9. **Sign-in copy and form.** IP *or* rig password; common passwords and anything under 8 characters are
   never proof, so those miners sign in by IP; the pool checks and the games never store the proof; a
   link to `/#rx-miner-guide`. The inputs carry no `name` (a fallback submit sends nothing), the proof box
   is `type=password` with a Show toggle, and the address shape is checked before any call. Refusals show
   the server's own `hint`.
10. **The "How plays are earned" fold states DEFAULTS** ("by default 10 minutes = 1 play, 24 a day, 100
    held"). No public route reports the live settings; if the operator changes them the page is wrong
    until Part 9 surfaces them (a `GET /play/api/rules`, or fields on `/me`).
11. **Confirmations are two-click in-page** (Resign, Log out everywhere: the button arms for 5 s). No
    native dialog anywhere on the page.
12. **`#m=<id>`** reopens a match after a reload. Signed-in only in v1: the API already serves a
    spectator view (`you: null`) and the frame draws one, but a public spectator page is Part 10's call.
    No `turns` polling yet — a bot game answers in the same request; `/me` refreshes every 5 min while
    the page is visible and on returning to the tab.
13. **The frame keeps its own two palettes** (it is a separate, opaque-origin document; the pool tokens
    cannot reach it), chosen by the `theme` message the shell sends from `GriniumTheme.isLight()` and on
    every body-class change. Its dark squares were lightened after the probe screenshots showed black
    pieces barely reading on them. A `data:` favicon keeps a direct visit from requesting
    `/favicon.ico`.
14. **Self-review (the plan's three questions).** (a) API data never reaches `innerHTML`: the shell and
    frame JS contain no HTML sink at all (`test-shell.js` enforces it), and the pool chrome's own
    `innerHTML` renders only its static NAV through `esc()`; the probe planted
    `<img src=x onerror=…>` in a label and it rendered as text. (b) No inline script or handler in
    either page (enforced; 0 CSP violations under the real header). (c) A 502 HTML page → the offline
    panel (probe + test).

**Part 7 — leaderboards, events, the admin Events page (2026-09-28, not VPS-tested).** Games service:
NEW `play/server/lib/{leaderboard,events,admin,badges}.js` + `lib/events/`; the /play/ G-06 panel
(`play/shell/js/play-boards.js`); pool: NEW `admin-panel/games-events.html` + a NAV group, **no
backend code**. As built in impl §10.13 *Part 7*. What changed against §19.3, §19.9, §19.11 and the plan:

1. **Modules beyond the plan's list.** `admin.js` is the games side of the admin proxy (every
   `/internal/admin/*` route goes through it; Parts 8–9 add theirs with `admin.add()`); `badges.js`
   holds the badge list; `events/_rules.js` the kind helpers; `events/index.js` the kind LIST.
   **Kinds are listed, not discovered:** the service never `require()`s a computed path
   (test-skeleton [h]), so a directory scan was refused. D17 still holds — a new kind is a module plus
   one line in `events/index.js`; `events.js` is not touched.
2. **The admin guard runs before the body is read** (a new route `guard` option in `http.js`), so a
   caller without the secret never gets 16 KB parsed — §19.3's "secret first" mirrored on this side.
   Order: `X-Forwarded-For` / `X-Real-IP` or a non-loopback peer → 404 (the pool's third guard,
   copied); secret → 503 `link_not_configured` / 401 `unauthorised`; `X-Admin-User` (printable
   ASCII, 1–64) → 400; `X-Admin-Stepup: 1` on every non-FAST write → 403 `step_up_required`. The
   secret is compared **inside** `pool-link.js` (`checkSecret` returns a verdict), so it never leaves
   that module. `FAST_WRITES` is copied verbatim from the pool, and `test-events.js` compares the two
   lists as text.
3. **Leaderboard parameters, exactly.** `board` = `points` (default) | `rating` | `wins`.
   `board=points` with no `game` is **points held** (`players.points`, so event rewards and
   `admin_adjust` count), all time only. `rating` needs a game with `pvp` and is all time only.
   `wins` / `points` with a game need `mode`; `period` = the CURRENT UTC day, ISO week (Monday–
   Sunday) or month, or `all` — there is no date parameter (past periods live on in events). An
   unknown or repeated parameter, or an unknown game, is 400 with `field`. Response:
   `{ board, game, mode, period, from, to, unit, computed_at, total, rows:[{ rank, name, value, games?, own? }], you }`.
4. **What is not ranked:** a zero value (a wins board of people with no wins is noise) and a banned
   address, on every board and in every event. The rank is the position after the §19.9 tie-break, so
   two equal values never share a rank. The 60 s cache also expires when the UTC day rolls over, and
   its key space is closed (a validated game × fixed enums), so requests cannot grow it.
5. **Rating and PvP boards are API-only until Part 10.** The shell offers points held plus wins and
   points against the bot; Part 10 adds the rating board and the `pvp` options when PvP ships.
6. **Event validation.** Windows are whole UTC days, at most 366 long, starting today or later and at
   most 366 days ahead (no backdated events). An event starting today is created `running`, not
   `scheduled`-then-flipped. The title is NFC, 1–60 chars, and a control, bidi-override/isolate or
   zero-width character **refuses** the save (not stripped: the operator should see why). Unknown
   keys anywhere are refused, as in every other games body.
7. **Rewards.** Up to 10 tiers, ranks 1–1000, in rank order and non-overlapping (so "the first tier
   holding the rank" is also the only one), 0–10 000 points each. **Participation gained an optional
   `badge`** (§19.9 edited): without it the "Took part" badge could not exist. A tier winner does not
   also get the participation reward. Badge ids: `gold`, `silver`, `bronze`, `top10`, `champion`,
   `marathon`, `regular`, `took_part`.
8. **Editing.** `scheduled`: every field. `running`: title, last day and rewards only — kind, rules
   and first day are what players are competing on (re-sending them unchanged is fine; the form posts
   every field). The last day may be moved earlier, but not to a day already over. Later states:
   409 `not_editable`.
9. **Finalise-now** (`POST events/:id/finalise`, step-up) needs the window to be over (409
   `not_ended`): it skips the 10-min grace and retries a stuck `finalising` event; it never ends a
   competition early. Cancel is `POST events/:id/cancel {reason?}` (step-up). `GET event-kinds` (kinds
   with their form fields, the badge list, the games, the limits) was added for the admin form.
10. **Exactly once, three guards:** the state flip `finalising → done` must change one row; the ledger
    ref `e:<id>` is unique per address (`uq_ledger_ref`); `event_results`' primary key refuses a
    second row. The test forces an event back to `finalising` and checks the re-finalise fails
    whole and pays nothing. A compute that throws leaves the event `finalising`; every 5-min tick
    retries it (20 per tick).
11. **Badges** are stored as `badges_json = [{ id, event }]`: one per event per address, at most 500
    per address (past that, the event's results still record it). `/me` gains
    `badges: [{ id, label, event_id }]`; the shell shows them on the account strip.
12. **Admin page.** Date inputs, not `datetime-local` (§19.11 edited): the window IS whole days, so a
    time field would show something that means nothing. The last day is inclusive and is sent as the
    next midnight. **Every proxied call uses `adminFetch`, not `API.*`:** `Auth.fetch` sends the
    admin to the login page on any 401, and the proxy passes the games service's own 401 (a
    link-secret mismatch) through. A 401 whose body has `ok: false` is shown as "rotate the link
    secret"; only the pool's own 401 (never carries `ok`) goes to login. **Part 9's games pages need
    the same.** NAV: a Games group between Dashboard and Settings, parent `games-events.html` until
    Part 9's `games.html` exists.
13. **Public visibility.** The list is every scheduled / running / finalising event plus done or
    cancelled ones that ended in the last 90 days (older ones stay readable by id). A cancelled event
    that never started was never shown as running, so it is hidden from the list AND the detail.
    Running standings are cached 60 s; the admin detail computes fresh (full addresses, ≤ 1 000), so an
    operator read neither sees nor pins a stale board.
14. **`mod_actions` retention is built here** (hourly, 365 days, §19.10) because this part writes the
    first rows; each admin write adds its row inside the write's own transaction. Part 8 need not add
    it. Jobs: `event_transitions` (5 m, registered after `activity_sync`), `mod_actions_purge` (1 h).
15. **Self-review (the plan's questions).** (a) *Can an event reward be paid twice?* No — #10, tested
    with a second tick, a direct call, a forced replay and a duplicate ledger ref. (b) *Can a cancelled
    event pay?* No: cancel and finalise both flip the state under the write lock, and finalise acts only
    on `finalising`; tested for a cancel after the window ended and a cancel from `finalising`.
    (c) *Does any leaderboard query scan `matches`?* No: every board and kind reads `players`,
    `ratings`, `results_daily` or `activity_daily` on its index (`EXPLAIN`-tested), and a source
    check forbids `FROM matches|match_moves|ledger` in these modules. **For Part 11 (§19.13 #19):**
    `event_results` is kept forever — one row per ranked address per event, bounded by the addresses
    that mined or played in the window.

**Part 8 — chat backend + moderation, and moderators (2026-09-28, not VPS-tested).** Games service only:
NEW `play/server/lib/{chat,moderation}.js`, migration v2 in `lib/db.js`, the mining gate + `modStatus` in
`auth.js`, settings in `settings.js`, wiring in `app.js`; **no pool code**. As built in impl §10.13 *Part 8*.
What changed against §19.4, §19.10, §19.11 and the plan:

1. **Schema v2 = migration 2, new tables only** (`moderators`, `chat_words`; §19.4's block edited in the
   same change, as Part 1 requires). No `ALTER`, so the stored text of every v1 table is unchanged. A DB
   left at v1 upgrades in place (tested). The word list is a table, not a setting: it is edited a word
   at a time and has its own bound (500 entries, 1–40 characters).
2. **Moderators (D21)** — the operator's question during this session; the whole feature is D21 plus
   the routes in §19.10 and the admin routes below.
3. **The change feed** (§19.10 edited). Without it, a scam message the operator deletes stays on every
   page that already drew it until a reload. The log is per process and bounded (1 000 entries); a poll
   with an unknown `epoch` or an out-of-range `rev` gets `reset: true` and a fresh page. A message
   approved or restored arrives in `changes.shown` if it is older than the client's `after`, and as an
   ordinary new message if it is newer, so it is delivered exactly once.
4. **Normalisation, refined.** Control characters (Cc) and line/paragraph separators become a **space**,
   not nothing, so a control between two words cannot glue them into one. Every format character (Cf)
   is removed through a Unicode property escape: that covers §19.10's list plus LRM/RLM, U+061C and the
   soft hyphen. Hangul fillers (letters that render as nothing) are removed. A run of more than 3
   combining marks is cut to 3 ("Zalgo"). The hold checks compare an NFKC-folded, lower-cased copy, so
   fullwidth `ｗｗｗ．` is caught; the stored body stays NFC.
5. **A Grin address is held with links** (under `chat_hold_links`): "send 5 GRIN to grin1…" is this
   chain's scam link.
6. **Limits.** Per address: the 5 s floor, `chat_posts_per_hour` (default 30, max 60), slow mode — all
   read from the DB, so they hold across restarts and every session of an address. Per IP: 60 an hour,
   in memory. Moderators skip slow mode only. The recent-mining gate comes **before** the proof wait in
   `chatStatus` (reason `no_recent_mining` + `mining: { have_minutes, need_minutes, days }`), because it
   is the one the player can act on; its window is today plus `chat_recent_days − 1` days before.
7. **Reports need a chat-capable session**, not just a session (§19.10 edited): 3 "distinct reporters"
   must be 3 aged, mining addresses, or one fresh proof per address could hide anyone. 20 reports an hour
   per reporter; operator and own messages are not reportable.
8. **Reading with chat off** answers `200 { enabled: false, messages: [] }`, not an error, so the page
   can show "closed" without treating it as an outage.
9. **Admin routes added** (all step-up by the fail-closed rule; `FAST_WRITES` unchanged): message
   restore, unmute, ban / unban, purge, `admin_adjust`, the word list, settings, moderator appoint /
   remove. Reads: messages by state or address, the report queue, players (one, or muted / banned /
   moderators), moderators, settings, the mod log. **Approve doubles as "keep"** for a visible,
   reported message: it resolves the reports and changes nothing else — no new fast route was needed.
10. **Ban** revokes every session at once (closes §19.15 *Part 4* #14), blocks login before the pool
    call, and ends a moderator appointment. An operator mute is set exactly (it may shorten one); a
    moderator's never shortens a mute already in place.
11. **Settings** (`lib/settings.js SPEC`): `chat_min_minutes` 60, `chat_recent_days` 7,
    `chat_posts_per_hour` 30, `chat_slow_seconds` 0, `chat_hold_links` true, `chat_report_threshold` 3,
    `chat_retention_days` 7, `chat_retention_max` 2000, `mod_requires_password` true. A save validates
    every key first and writes them in one transaction (a quoted `"false"` for a bool refuses the whole
    save). The floors are constants shown by the admin page, never settings.
12. **`GET /play/api/rules`** — the live plays, points and chat rules, nothing per player. Closes
    §19.15 *Part 6* #10.
13. **Jobs:** `chat_retention` (1 h, batched 5 000 rows a run, reports deleted before their message).
14. **Accepted, recorded:** the admin message list filtered by address pages approximately (the
    `before` filter applies after the address read's limit); the players lists scan `players`
    (admin-only, at most 200 rows returned).
15. **Self-review (the plan's questions).** (a) *Can a public request create an operator message?* No:
    `role` is not an input (a body carrying it is refused), the operator role is set only by
    `chat/post` behind the link secret, and the moderator badge is computed from the moderators table
    (tested). (b) *Can a muted user post from a second session?* No: `muted_until` is on `players`,
    joined into every session lookup, and the per-address limits count rows in the DB (tested with two
    sessions). (c) *What does a 1 000-client poll storm cost?* One bounded index range read per request
    (`EXPLAIN`-tested on `idx_chat_room` / `idx_chat_address` / the `activity_daily` key), a scan of the
    ≤ 1 000-entry change log in memory, and no write except the 5-minute session touch.

**Part 9 — the chat UI and the admin pages (2026-09-28, not VPS-tested).** NEW
`play/shell/js/play-chat.js` + the G-07 panel in `shell/index.html` + chat styles; one hunk in
`play-shell.js`; pool admin: NEW `games.html`, `games-chat.html`, `games-players.html`,
`games-admin.js`, the NAV group in `admin-shell.js`. **No pool backend code.** As built in impl §10.13
*Part 9*. What changed against §19.10, §19.11 and the plan:

1. **`play:me`.** `play-shell.js` announces every rendered `/me` (and `null` on sign-out) as a DOM
   event, the same pattern as Part 7's `play:view`; the chat panel follows it, so the shell never has
   to know the panel exists.
2. **Polling:** 4 s signed in and visible, 15 s signed out (reading is public, §19.10), 30 s while the
   tab is hidden, 60 s while chat is closed; `setTimeout`, one request in flight. "Stop on logout" in the
   plan became "reset on logout": the panel keeps showing the public room.
3. **Rendering:** every message node is built with `createElement` + `textContent`; no `<a>` is ever
   created, so a link is inert text. The badges come from `role`. The panel says a masked name can be
   imitated and only the Operator badge is proof (§19.13 #10). Report and the moderator buttons are
   two-click in-page confirms, as everywhere on /play/.
4. **Moderators in the shell (D21):** a "Moderator queue" fold for an appointed address, plus Delete and
   Mute 1 h on ordinary players' messages; the server re-checks everything.
5. **Live rules:** the "How plays are earned" fold now shows the live settings from `/play/api/rules`
   (the HTML keeps the defaults for a failed fetch), plus a chat line.
6. **Admin text rule.** §19.10 says chat bodies are never `innerHTML` on the admin pages either. The pool
   panel's `AdminTable` renders rows from HTML strings, so these pages build every row that carries
   player or moderator text (bodies, report reasons, mod-log details) with DOM calls through
   `games-admin.js el()` and do not use `AdminTable`. `test-admin-panel.js` [14] fails on any HTML sink
   in the helper or the three page scripts.
7. **`games-admin.js`** carries the proxy call (with Part 7's 401 rule), the confirm dialog and the DOM
   builders for the three new pages. `games-events.html` keeps its own copy of `call()` (unchanged).
8. **`games.html` builds its form from the service's setting spec** (labels and groups on the page), so a
   key added later still gets a field. The proof age is shown in hours and stored in seconds.
9. **Match void** is not on the Players page: it arrives with PvP (Part 10), which owns `void`.
10. **Self-review.** (a) *Any path rendering a chat body as HTML?* No: shell — `play-chat.js` has no HTML
    sink (`test-shell.js`), and the probe planted `<img src=x onerror=…>` and `<script>` in bodies and a
    report reason: they showed as text, the handler never ran, no `<img>`/`<a>`/`<script>` element was
    created. Admin — no HTML sink in `games-admin.js` or the three page scripts (tested). (b) *Does the
    admin CSP stay unchanged?* Yes: the pages use only inline script, already allowed there, and no new
    origin. The probe ran the shell under the real `/play/` CSP header: 0 violations, 0 console errors,
    at 1280 and 390 px, dark and light, signed out and as a moderator.

**Part 10 — PvP correspondence chess + the "add a game" checklist (2026-09-28, not VPS-tested).** Games
service: `play/server/lib/matches.js` (PvP), NEW `lib/ratings.js`, four settings; shell: NEW
`play/shell/js/play-lobby.js` + the G-08 panel, the board in `play-shell.js`, PvP boards in `play-boards.js`;
pool admin: the Void button on `games-players.html`, a PvP group on `games.html`; **no pool backend code and
no schema change**. As built in impl §10.13 *Part 10*. What changed against §19.4, §19.6, §19.8, §19.9,
§19.11 and the plan:

0. **Scope question, recorded.** The operator opened this session asking for "Grin 2048 (a skill game, the
   server replays the moves), proving a new game needs no platform code". That contradicts D20 (2048 dropped
   from v1) and §19.8 (the `skill` kind is reserved and is built WITH its first game: migration 3 `rounds`,
   a registry kind, round routes, a score board) — so a 2048 folder cannot prove "no platform code". Asked;
   the operator chose to run Part 10 as planned. The "add a game" checklist in `play/README.md` now says
   exactly this: a new `match` game is one folder; a `skill`/`chance` game is a design + build session first.
1. **No schema change.** PvP uses the v1 columns Part 0 designed in. A PvP `params_json` is
   `{ move_seconds, colour, cost }` (no `bot_level`); `target` stays set after acceptance. `reason` gains the
   values `cancelled`, `declined`, `expired`, `abort`, `agreement` and `void` (the column is free text; §19.4's
   comment lists the common ones and is left alone because the block is test-bound).
2. **A seek/challenge's `turn_deadline` is its 72 h expiry.** One index (`idx_matches_state`) and one sweep
   cover move clocks and expiries; the sweep now walks each of `active`, `seek`, `challenge` with its own
   batch. Lazy expiry: any write on an open match (accept / decline / cancel) finalises it first and answers
   409 `expired`; the lobby and turns reads are read-only and just filter past deadlines out.
3. **Rated also gates `results_daily`.** An unrated PvP result writes no points, no rating AND no
   `results_daily` row, so a pair past `pair_rated_daily` cannot farm the wins boards or a `game_results`
   event either (the plan's self-review c). The match row keeps the full history. `pair_rated_daily` 0 = no
   PvP match is rated.
4. **A PvP resign at `ply < 2` is an abort** (both refunded, no result) — a result at ply 0 would hand over
   a rated win without a game. `POST /abort` itself answers 409 `too_late` from ply 2.
5. **Draws.** Offering while the opponent's offer stands accepts it (a draw by `agreement`). A move by
   either side clears an offer (§19.8 step 5 — also the offerer's own move). Draw actions share the move
   limiter (burst 3, 1/s per address), which bounds offer spam.
6. **Caps.** The open cap counts on the seat indexes (a creator always holds a seat). The active cap is
   checked at create AND for both sides at accept: a full acceptor → 409 `too_many_matches`, a full creator
   → 409 `opponent_busy`. The caller's own lapsed matches are finalised first (creator at create, acceptor
   at accept), so a dead game never counts. A challenge target is shape-checked only (this network's
   prefix, not the challenger's own address → 400 `self_match`) — never looked up: a "banned" or "unknown"
   answer would be an oracle on other addresses. A challenge to an address that never plays expires and
   refunds.
7. **Shapes for the shell.** Every view and summary gains `actions` (what THIS viewer may do next),
   `open_seat`, `invited`, `target_label` (the target MASKED, and only to the challenger and the target),
   `expires_at`, `rated`, `draw_offer_by`. `GET /play/api/lobby` → `{ seeks, challenges }`, rows
   `{ id, game_id, name (masked), you_play, move_seconds, created_at, expires_at, own }`, no query
   parameters; `GET /play/api/matches/turns` → `{ your_turn, active, draw_offers, challenges,
   last_move_at }`. New error codes: `self_match` 400, `not_invited` 403, `not_open` 409, `expired` 409,
   `too_many_open` 409, `too_many_matches` 409, `opponent_busy` 409, `no_draw_offer` 409, `too_late` 409,
   `not_voidable` 409.
8. **Query plans.** The incoming-challenge reads name their index (`INDEXED BY idx_matches_target`, then
   `ORDER BY id DESC`, no sort): with no table statistics the planner chose `idx_matches_state`, which walks
   every open challenge in the pool to find one address's. `INDEXED BY` also fails the prepare loudly if the
   index is ever dropped. The lobby orders by `turn_deadline DESC` (= newest, with no sort). All `EXPLAIN`-tested.
9. **Ratings** (`lib/ratings.js`) are zero-sum by construction (seat 2 moves by the negation of seat 1's
   rounded change). `recompute(game)` replays finished, rated, non-void matches in `(finished_at, id)` order
   and lands on the incremental result (tested), with one recorded exception: two rated matches of one game
   that share a player and settle in the same second, the later-settled having the smaller id, replay in the
   other order — a point or two for those players; ratings are derived and never money.
10. **Void** (`POST /internal/admin/matches/:id/void {reason?}`, step-up by the fail-closed rule): active →
    `void` with every seat refunded; seek/challenge → `void` with the creator refunded; finished → `void`
    **keeping** its result and reason for the record, the points it paid reversed with `admin_void` rows
    (the amount credited, clamped to the current balance — the ledger refuses an overdraft), its
    `results_daily` counts removed, and the game's ratings recomputed if it was rated. Event rewards already
    paid are not clawed back (as cancelling a `done` event). One `mod_actions` row, action `match_void`,
    target `m:<id>`. Anything else → 409 `not_voidable`.
11. **Settings** (`lib/settings.js`): `pvp_play_cost` 1 (0–10), `pvp_active_max` 10 (1–50), `pvp_open_max`
    5 (1–20), `pair_rated_daily` 3 (0–20); `/play/api/rules` reports them. The move-time options stay
    manifest values (a game defines its own pace), so §19.11's "chess move-time options" setting was not
    built. PvP point values stay manifest values (§19.15 *Part 5* #3).
12. **Shell.** The lobby is its own file and talks to the page only through events (`play:open`,
    `play:changed`, and it listens to `play:me` / `play:turns`), as the boards and chat panels do. The board
    shows exactly the view's `actions`. Polls: the open board every 5 s while the opponent is to move (or
    one's own seek/challenge waits), visible tabs only, with `since_ply`; turns every 15 s visible / 60 s
    hidden, reloading My games only when its signature changes. **Both forms gained a Game picker, hidden
    while one game offers that mode** — without it the checklist's "a new game needs no shell change" was
    false (the forms took the first game). A public spectator page (Part 6 #12) was NOT added: the board is
    still signed-in only; the API serves spectators masked views, for Part 11 to weigh.
13. **Self-review (the plan's questions).** (a) *Can a player move in a match that has timed out?* No: the
    deadline check runs first for every action on an active match (move, resign, draw, abort), finalises it
    in that transaction and answers 409 `timeout`; a second try is 409 `not_active` (tested). (b) *Can a
    refund and a settle both happen for one match?* No: settle and abort/void both move a row out of
    `active` with `WHERE state = 'active'` that must change one row, open matches leave through `WHERE state
    IN ('seek','challenge')`, and every ledger row carries a unique `m:<id>:<seat>` ref — tested with a
    join (no seat has both a refund and points) and "no seat refunded more than it paid". (c) *Paid for a
    match against yourself or beyond the pair cap?* The same address is refused at create and at accept.
    Two addresses of one person cannot be told apart; what bounds it: both sides pay a play per game (from
    mining minutes), 3 rated games per pair per UTC day, `points_daily_cap` per address, and unrated games
    counting nowhere (#3). Resigning right after ply 2 to feed a partner is within those bounds — accepted,
    recorded. (d) *Engine assistance* is undetectable — accepted (D20); the "How plays are earned" fold now
    says so to players.

**Part 11 review — independent review of Parts 1–10 (2026-09-28, a session that built none of it; code
review on Windows, nothing run on a VPS).** Read: all of §19, then the code: `play/server/**`,
`play/shell/**`, `play/games/chess/**`, `back-end-pool/lib/games-link.js` + its `index.js` mount lines,
`scripts/lib/07_lib_pool_games.sh`, the pool script's menu / vhost / deploy / cron hooks, the backup and
migrate hooks, and the five games admin pages + `games-admin.js`. Games `npm test` 918 → **921/921**, pool
`npm test` 2322 → **2330/2330**; `bash -n` clean on the four touched shell files.

*Fixed (smallest change at the source, each with a test where code changed):*

1. **A free bot game fed the wins boards and events.** Part 5 #2 stopped a free game (`bot_play_cost` 0)
   paying points, but `settle` still wrote its win to `results_daily`, the source of the bot wins board and
   of `game_results` events, whose rewards are exempt from `points_daily_cap`. With the operator's "free for
   testing" setting left on, a level-1 bot was an unlimited win tap needing no mining — the D10 bypass Part 5
   closed, one table over. Now a match with cost 0 (bot or PvP) enters no `results_daily` row
   (`matches.js` `settle`, the `params.cost > 0` guard), and admin void takes counts off only for matches
   `settle` counted — without that second guard, voiding a free match would have decremented a **paid**
   match's row of the same day. Tests: `test-matches.js` (d), `test-pvp.js` (e) — free rated PvP + its void.
2. **The pool had no cap of its own on the internal routes (§19.13 #12).** The games service's limiter chain
   stops an HONEST caller, but a compromised `grinplay` process holds the secret and chooses `client_ip`
   (D7 trusts it), so the pool's per-IP proof throttles saw a fresh IP per call: unbounded 16 MB scrypts and
   unbounded activity queries on the process that serves stratum. `games-link.js` now caps, keyed on nothing a
   caller controls: verify-proof ≤ 4 in flight and 120 / min, activity 60 per 5 min (an honest sync makes
   ≤ 24 per 5-min tick) → 429 `busy`, which the games side already reads as "pool unavailable". Checked after
   input validation, so a malformed call spends nothing. Test: `test-games-link.js` [14]. This is pool
   backend code: it ships with the pool deploy that Part 2's code already needs (checkpoint A was skipped, so
   nothing is deployed yet).
3. **§19.6 and `plays.js` said a settings change "never recomputes the past".** `due` is taken from the
   day's running total, so a change re-rates the CURRENT UTC day (lower `minutes_per_play` mid-day → the
   difference is credited at the next window). Harmless, operator-only, never an earlier day — the text was
   wrong, not the code. Both now say so.
4. **§19.13 #7 was not stated on /play/.** The sign-in card now says that anyone who can give a proof — a
   stranger who mined a few shares to the address, or a CGNAT neighbour — signs in as it and can spend its
   plays or play in its name, and why that is accepted (`shell/index.html`, the G-01 hints).
5. **Pool menu:** the `B) Backup & Restore` row lost a column when `P` was inserted (cosmetic).

*Open — for the operator (not changed here):*

- **O1 (Part 6 #3, pool-side) — CLOSED 2026-10-03 by decision D22 (§19.17).** The operator chose
  option B: the custom-HTML sinks and `code` ads are **deleted** for every page, rather than this one page
  being opted out. The code change is Part C1 and is not built yet. Original text:
  `account-settings.html` takes the rig **password** — the same credential
  /play/ takes, which since D21 also carries moderator power — yet does not opt out of untrusted HTML
  (`CREDENTIAL_PAGES` is `['login']`), so operator analytics, custom HTML and `code` ads run beside that
  input. Recommendation: treat it as a credential page, exactly as /play/ does (`data-untrusted-html="exempt"`).
  Not changed: it removes the operator's analytics and ads from a public page, which is their call. Logged in
  `script07_security_audit.md`.
- **O2 (#20, D21).** The aged-proof + password gates **delay** a stranger who mines to a moderator's address
  with their OWN non-trivial rig password; they do not stop one. After `chat_min_proof_age` that stranger
  opens a password-proof session and holds the moderator's powers (the recent-mining gate counts the
  address's minutes, not the stranger's), logged as `mod:<the moderator's address>` — indistinguishable from
  the real moderator in the mod log. Bounded: chat only, mutes ≤ 24 h, every action reversible and logged,
  no full addresses. Recommendation: accept for v1 and confirm together with D21 at acceptance; if not, the
  small next step is to record the acting session's `ip_coarse` / `ua_hint` in the mod-log row so the
  operator can tell two actors apart.

*Decided here (the questions earlier parts left to this review):*

- **Ledger retention (Part 4 #13): keep, no rollup in v1.** Rows: ≤ 24 `mining_minutes` per address per day
  (the daily cap) + 1–3 per match — about 0.5 M a year at 50 active miners. `verify()` is one hourly
  `GROUP BY` in the games process only (never the pool), with a 5 s budget whose overrun the maintenance
  tier logs (`over budget`): that warning is the trigger to build a checkpoint rollup. Exactly-once does not
  need old `w:` refs — `activity_sync.window_from UNIQUE` is the primary guard.
- **Part 10 #9 (same-second recompute order), #10 (void keeps the result, clamps the reversal), #13(c)
  (multi-address farming bounds): accepted as recorded.** #6 confirmed: `createPvp` never reads the target
  (no oracle). **#12:** `GET /play/api/matches/:id` is public and ids are sequential, so every match is
  enumerable; accepted — the view carries masked labels only, never `seed`, `created_by` or a full `target`
  (the target is masked, and shown only to the two parties). A public read also finalises a passed deadline
  (one match, idempotent) — accepted.

*The §19.13 threat notes, answered against the code (✓ = confirmed safe):*

| # | Verdict | Evidence |
|---|---|---|
| 1 Forged move / result | ✓ | Bodies are exact-key (`matches.js body()`, an unknown key → 400); a move is `{ply, move}` only and goes through `move_pattern` + `rules.apply` inside the transaction (`move()` → `playOne`); position, result, points and rating are written only by `settle`/`abort`. |
| 2 Races | ✓ | One `BEGIN IMMEDIATE` per action (`db.js` transaction); `ply !== m.ply` → 409 `stale`; every exit from `active` / open is `UPDATE … WHERE state = …` that must change one row; `uq_ledger_ref` makes each `m:<id>:<seat>` credit or refund exactly-once. |
| 3 Plays farming | ✓ (+ fix 3) | Credits come only from pool activity rows; windows contiguous from the watermark, `window_from UNIQUE`, the ledger ref a second guard; seconds clamped to the window; balance cap clamps `delta`. Retroactivity = the current UTC day only (fix 3). |
| 4 Pair farming | ✓ | `isRated` counts both seat orders on `idx_matches_pair`, inside the settle transaction; unrated and (fix 1) free matches count nowhere. Multi-address: accepted (D1). |
| 5 Bot abuse | ✓ | No takeback: the bot replies in the same transaction; `abort` is PvP-only. CPU: `BOT_NODE_BUDGET` 20 000, one active bot game per game (partial unique index), 1 move/s per address (`rateMove`); a throwing `rules.js` → 500 `game_error` + rollback (`call()`). |
| 6 Session / CSRF | ✓ | Cookie exactly `HttpOnly; Secure; SameSite=Strict; Path=/play/; Max-Age=1209600`; only `sha256(token)` stored; logout-all and ban revoke every session; POST needs the JSON content type (`http.js readJson`) and passes `sameOriginOk` (Origin + `Sec-Fetch-Site`) in `publicRoute`. |
| 7 Login as someone else | accepted, now stated (fix 4) | Exactly as strong as the account page's proof (one pool verify on the real IP). Chat is aged (D9); games actions are not; worthless points (D1). |
| 8 Frame escape | ✓ | `sandbox="allow-scripts"` exactly (`frame-host.js`), frame CSP `connect-src 'none'` + `sandbox allow-scripts` (the nginx snippet), `event.source` check + exact-key schemas both ways; `state` carries only on-screen data. |
| 9 Chat XSS | ✓ | Shell, chess frame and the chat/players/settings admin pages: no `innerHTML`/`insertAdjacentHTML` sink at all. `games-events.html` builds rows as HTML strings through `escHtml`, which escapes `& < > " '`. |
| 10 Impersonation | ✓ | `role` is never an input; only `/internal/admin/chat/post` → `operatorPost` writes `role='operator'`. The Mod badge is computed from the real address at read time, so a ground 9…4 mask never inherits it. |
| 11 Chat flood | ✓ | Per-address limits read the DB (a second session shares them, `addressLimits`); 60/h per IP; slow mode; 4 KB body; mute is on the player row. Every read is an index range (`idx_chat_room`, `idx_chat_address`, PK). |
| 12 Pool stall | ✓ (+ fix 2) | Secret before any body, DB read or scrypt (`games-link.js internal()`); activity bounded ≤ 3600 s and pinned `INDEXED BY idx_hashrate_time`; verify on the real IP; now a global cap too. |
| 13 Secret leak | ✓ | openssl → temp file (`umask 077`) → chown/chmod 0440 → `mv`; never argv, env, echo or a response; the unit carries only the path; the P → 5 probe reads it inside `node`; logs carry codes only. |
| 14 `/internal` via nginx | ✓ | No pool location proxies it + `location ^~ /internal/ { return 404; }`; nginx decodes and resolves `..` BEFORE matching, so `/play/api/%2e%2e/…` cannot land in `/play/api/`; the pool and games guards both 404 anything carrying `X-Forwarded-For`/`X-Real-IP` (nginx always adds them); the games router matches raw paths, never decoded. |
| 15 Cloudflare | ✓ | `/play/` and frames `no-cache`, API `no-store` + nosniff (`http.js JSON_HEADERS`), assets `?v=` stamped at deploy. |
| 16 Mode switch | ✓ | `off` → 404 on every public route (`publicRoute`, health excepted); nav shows only on `on` (`data-games`); `publicFlag()` reads off while the probe is unhealthy, and a flip flushes the branding memo. |
| 17 Numbers | ✓ | `parseIntStrict` everywhere a number is read; ledger `DELTA_MAX` 1e9; ban `FOREVER` 253402300799 < 2^53; settings bounded in `SPEC`. |
| 18 Public lists | ✓ | Boards, events, lobby, chat and match views emit `maskAddr` only; the games suites carry the leak check. |
| 19 Growth | ✓ (ledger: decided above) | sessions 30 d after death, chat 7 d / 2 000, `mod_actions` 365 d, bot moves 60 d, rate-limit maps bounded (`maxKeys`); `activity_*`, `results_daily`, `matches`, PvP moves and events are small and kept. |
| 20 Moderators | ✓ except O2 | Operator posts and other moderators are protected (`protectedFrom`); no self-approve, self-mute or self-unmute (a muted moderator cannot act); a mute never shortens; no `/internal/admin` reach; masked names only; `modStatus` re-reads the table and the password setting on every request; a ban revokes sessions and ends the appointment. |

*The six mandatory probes:*

1. **Impact — every pool path the games can trigger, worst-case DB time.** verify-proof: the account page's
   own proof check (indexed proof-set reads, ONE async scrypt — up to 8 for unmigrated v1 rows — and one
   audit INSERT), now ≤ 4 in flight. activity: one indexed range read; row lookups = active miner-minutes in
   the window (≈ 3 000 at 50 miners) — the < 50 ms bound is owed to the live-box run (impact budget 3). config:
   one settings read / 60 s. Admin proxy: admin-initiated; one `admin_audit_log` INSERT on step-up paths.
   Health probe and branding flag: no DB beyond the memoised branding read. Nothing on the share, block,
   reward or payout paths.
2. **Games never opens `pool.db`:** every `require` under `play/server` is local or `node:*`; no path to
   `pool.db` or `back-end-pool/` anywhere.
3. **nginx:** every `proxy_pass` in the pool vhost sits in a location for `/api/…`, the admin auth check,
   a few exact files (`robots.txt`, `sitemap.xml`, `manifest.json`, the RSS feed, `page.html`) or the blog
   permalink regex — none can match `/internal/`; the games snippet proxies only `/play/api/login` and `/play/api/`, both setting `X-Real-IP`
   and `X-Forwarded-For`; the frame location omits the common snippet (no `X-Frame-Options DENY`) and writes
   nosniff / Referrer-Policy / HSTS itself; the glob include is safe when empty (owed to checkpoint A).
4. **Money:** `games-link.js` writes one table, `admin_audit_log`; `auditOwnerProof` writes the audit log.
   No pool money table is touched.
5. **XSS:** see #9.
6. **Suites:** games 921/921, pool 2330/2330 (before this review: 918 and 2322).

**Part 12 — approved nicknames (2026-09-28; not VPS-tested).** The contract is §19.16; these are the
places the build departs from the plan's one-paragraph prompt ("reuse §18.5 … display nickname + masked
suffix … admin queue"), and why.

1. **The display is composed on the SERVER, into the one `name` field.** `names.label(address)` returns the
   mask, or `Nick (grin1abcd…wxyz)`, and every public surface — chat, the three boards, event standings,
   the lobby, a match's seat labels and a challenge's target — calls it. No response carries a nickname
   without its mask, so no client can drop the mask (§19.13 #10: a mask costs ~2^40 key generations, a
   nickname nothing). The full 9…4 mask is kept rather than a shorter suffix: four characters would cost
   2^20. The shell never composes a name either (`test-shell.js` pins it).
2. **The rule is §18.5's, copied (D5: games never load pool code), with four changes.** 2–**20** characters,
   not 32 (a chat line and a board row have less room); **no dot** — a nickname sits beside chat, and
   `free-grin.io` as a name would be the scam link the chat's link hold exists to stop; **at least one
   letter**, not letter-or-digit; and two refusals before the queue: an **address-like** name (`grin1…` /
   `tgrin1…`, separators ignored, checked before the leet fold) and the **role words** `operator`, `admin`,
   `moderator` (leet + separators folded) — the words the page's own badges say.
3. **"No two live nicknames alike" is a database fact.** The matching form (lower-case, separators out,
   six leet digits folded — `donor-names.js normalise`, copied) is stored as `norm`, and `uq_nick_norm` is
   a partial unique index over the live rows. Submit and approve both check first (409 `nickname_taken`),
   and the index is the backstop a race cannot slip past (mutation-checked: with the approve check deleted
   the index still refuses, as a 500).
4. **The gate is the chat gate minus the chat switch.** `auth.chatStatus(s, { ignoreChatSwitch: true })`:
   an aged, non-anchor, recently-mining, unmuted session (and the password rule when it is on). The switch
   is ignored because nicknames show on the boards too, so closing chat must not freeze everyone's name.
5. **A games-owned switch `nicknames_enabled` (default on).** Off = no new requests AND every surface
   shows the bare mask; nothing is deleted, so on brings the approved names back. It is in `SPEC`, so
   `games.html` shows it (its own group, "Nicknames").
6. **Every admin write is STEP-UP; `FAST_WRITES` is unchanged, so there is no pool backend change.** The
   three writes are not in the fast list, so the pool asks for the password — the same as its own donor
   queue (§18.6 `freshAdmin`). Moderators (D21) have no nickname powers.
7. **A ban ends the nickname** (and refuses a pending one), inside the ban's own transaction; the ban's
   `mod_actions` row names it. An unban does not restore it: the player asks again and it is reviewed again.
8. **Bounds.** 5 submissions per address per 24 h, counted from the table (a restart does not reset it);
   one pending + one live per address (partial unique indexes); decided rows (`rejected` / `replaced` /
   `withdrawn` / `removed`) are purged after 180 days by an hourly job (`nickname_purge`) — §19.13 #19.
9. **Schema v3** (§19.4): one table, five indexes, no `ALTER` — the v1/v2 `CREATE` text is unchanged.
   `test-skeleton.js` compares §19.4 with the migration, and upgrades a v1 and a v2 DB in place.
10. **The pending text is shown to its author only.** `/me` is session-bound, so unlike the pool's account
    page (public to anyone holding the address, §18.6) it can show the pending name back. It never reaches
    any other response (`test-names.js` scans every public response for it).
11. **Verified:** games `npm test` 921 → 1010 (NEW `test-names.js` 78; `test-skeleton.js` +2, the v2 → v3 upgrade;
    `test-shell.js` +9: six for the fold and the three per-file checks on the new script), pool 2330 → 2341
    (`test-admin-panel.js` [15], +11). Three mutations each turned `test-names.js` red (nickname shown
    without its mask; the gate removed; the approve-time taken check removed). **Not done:** no browser
    probe of the fold or the admin page (both were checked statically only), and nothing ran on a VPS.
12. **Part 13 must:** submit a nickname from a password-proof session, approve it in the panel, and see
    `Nick (mask)` in chat, on a board and in the lobby; reject one with a reason and see it on /play/; ban a
    named test address and see the name gone.

**Part C1 — Option B: the operator-code sinks removed (2026-10-04; not VPS-tested).** The contract is
§19.17.1 D22 and threat note #22. Pool front + back end only; no games code changed. What the build added to,
or found beyond, the plan's prompt:

1. **Deleted as D22 says.** The `code` ad type (the renderer, `activateScripts()`, create/update, the admin
   option, field and preview hint) and `analytics.custom_head_html` / `custom_body_html` (the render path,
   `cloneScript()`, the defaults, the branding payload, the admin textareas, the two `STEP_UP_SETTINGS_KEYS`
   entries — removed because the keys are gone, not un-gated; the existing "every gated key exists in a real
   section" test would have failed had they stayed). Image and text ads are untouched.
2. **A stored legacy value is HIDDEN, not deleted — and the hiding is stricter than the prompt.** The prompt
   said "never sent to a browser"; threat note #22 says "never reaches a browser", which includes the admin
   panel. So `pool-settings.js RETIRED_KEYS` keeps the two keys out of `getSection()` (hence out of the admin
   GET, `getAll()` and the public payload), and `updateSection()` refuses a write to either with "Custom HTML
   was removed for security (design §19.17 D22)". A legacy code ad is excluded from serving AND counting by one
   shared `SERVABLE` predicate spliced into both `publicByPlacement()` and `recordEvents()` (audit §J14-9: the
   two must not drift); `html_code` is no longer written, selected for the public, or returned to the admin
   (`_adminRow()` strips it and adds `removed: true`); such a row can only be deleted — even switching it off is
   refused, because an edited dead row would read as a live ad. Rows stay in the DB: nothing reads them.
3. **Found: the GA id could break out of the GA4 init text.** `loadGa4()` spliced the id into a `<script>`'s
   text with only `'` stripped, so a trailing `\` escaped the closing quote (`gtag('config','G-ABC\',{…`).
   The write validator (`^G-[A-Z0-9]+$`) blocked that for `analytics.ga_tracking_id`, but the payload's legacy
   fallback `seo.ga_tracking_id` has no validator at all. Every provider value is now checked three times:
   on write (`pool-settings.js` validators), on publish (`publishAnalytics()` turns a non-matching stored
   value into `''`) and in the browser (`branding.js`, same patterns) — `GA_ID_RE`, a domain list for
   Plausible, a token for Umami, digits for the Matomo site id.
4. **Found: the provider script URLs accepted any scheme.** `plausible_src`, `umami_src` and `matomo_url` were
   checked with `new URL()`, which parses `javascript:` and `data:` happily; either would have become the
   `<script src>`. Now https only, with a host and no credentials (http would be mixed content anyway), on the
   same three layers.
5. **Found: ad URLs had no check at all.** `link_url` reached an `<a href>` and `image_url` an `<img src>` on
   every page, so a `javascript:` link was code on click — the same class D22 removes. `lib/ads.js checkUrl()`
   now refuses anything but `''`, `#`, a site path (`/x`, never `//host` or `/\host`, which a browser reads as
   another origin) or an http(s) URL without credentials; `ads.js safeUrl()` re-checks, so a legacy row's bad
   link renders as no link and a bad image draws no banner. All shipped seeds pass (tested).
6. **Matomo stays, though D22 names three providers.** The code had four loaders. Matomo is the same class as
   Plausible and Umami (an https script origin plus an ID), so it was kept and given the same patterns rather
   than deleted on a list the C0 text may simply have abbreviated. Deleting it is a few lines if the operator
   wants exactly three.
7. **Unchanged on purpose.** The credential-page guard (`isCredentialPage()`) still withholds the CSS sinks and
   the provider script on `login.html` and any `data-untrusted-html="exempt"` page; its comment now records
   that the script sink it was written for is gone. `public-shell.js` still mounts no ads on exempt pages — the
   reason changed (a banner from an operator-chosen origin is a visit beacon, and a sign-in page has no use for
   one), the behaviour did not. **CSP was not touched** (item 9).
8. **Self-review — every remaining hit in `public_html` + `play/shell`, justified** (all pinned by NEW
   `scripts/test-operator-code-sinks.js`, which fails on any new one):
   - `createElement('script')` — **7**: `branding.js` `injectStructuredData` (a JSON-LD data block, a
     non-executing type filled with `textContent`), `loadGa4` ×2, `loadPlausible`, `loadUmami`, `loadMatomo`
     (each guarded as items 3–4); `public-shell.js` `mount` (`/js/ads.js`, a fixed path). C7's bubble loader is
     the next expected entry. `createElement('iframe')` — **1**: `play/shell/js/frame-host.js` `create`, the game
     frame, `sandbox="allow-scripts"` without same-origin.
   - `insertAdjacentHTML`, `document.write`, `srcdoc`, `createContextualFragment`, `new Function`, `eval`, a
     string timer, `setAttribute('on…')` — **0**. `outerHTML` — **1**, inside vendored Quill
     (`public_html/js/vendor/quill.js`), which only the admin CMS editor loads; no public page loads it (pinned).
   - `innerHTML` — **94** assignments in 20 script units (the per-file table is pinned exactly): clearing or
     constant markup; templates whose every interpolated string passes `esc` / `escHtml` / `escapeText` /
     `attr` or is a number formatter; and `Explorer.link()`, which escapes. **Except two — item 10.** `play/shell`
     has none (pinned).
9. **CSP inventory (prompt step 5) — dropping `'unsafe-inline'` from the public `script-src` is FEASIBLE
   later, as a mechanical follow-up.** Today: `script-src 'self' 'unsafe-inline' https://www.googletagmanager.com
   https://plausible.io https://cloud.umami.is` (`07_grin_mining_public_pool.sh`). What depends on
   `'unsafe-inline'`: **11 inline `<script>` blocks**, one each in 11 of the 13 public pages (account-settings,
   api-docs, blocks, blog, donate, fortune-board, login, miners-stats, page, payment-history, post); **11 inline
   handler attributes** in 4 pages (login 7, blog 2, donate 1, fortune-board 1); and **the GA4 init script** that
   `loadGa4()` builds with `textContent` — its text carries the page URL, so a hash cannot cover it; it needs a
   static `/js/ga-init.js` reading its values from a data attribute. No script template writes an inline handler,
   and the 5 JSON-LD blocks are data blocks that `script-src` does not govern. The `/play/` shell already runs
   without `'unsafe-inline'`. Noted in passing: the public `img-src` is `'self' data:` + Google, so an ad image on
   another origin is already refused by the browser — existing behaviour, not changed.
10. **⚠ OPEN — CMS page and post bodies are raw operator HTML on the origin, and D22 does not cover them.**
    `page.html` sets `page-body`.innerHTML to `json.data.html` (`lib/pages.js`) and `post.html` sets
    `post-body`.innerHTML to `p.body_html` (`lib/posts.js`, the Quill editor's output), both unsanitised, so an
    `<img onerror>` in a page or post runs on the origin for every visitor of it — exactly the class D22 deleted
    elsewhere. The writes are `secureAdmin` (no step-up), so a stolen admin session reaches it, the same
    escalation §J1-1 closed for custom HTML. It is worse after C7: both pages load `public-shell.js`, so the
    sign-in bubble will be on them, and a page body could read a guest password typed into it. Option B cannot
    delete these (they are the blog and the pages), so C1 records them, names them in the test (so a third raw
    sink cannot hide behind them), and stops. **For the operator, before C7 ships:** sanitise on render with a
    DOM allowlist (or a vendored sanitiser), move CMS bodies into a sandboxed frame, or restrict the editor to a
    markup subset rendered server-side. R1 cannot answer #22 "complete" while this stands.
11. **Verified:** pool `npm test` **2536 → 2662**, 0 failed (each file's own "N passed" line summed, 27 files;
    the per-file figures differ in method from earlier rows): NEW `test-operator-code-sinks.js` 92 (static
    allowlist + ratchet; `lib/ads.js` and `lib/pool-settings.js` against a throwaway DB; `ads.js` in a DOM shim);
    `test-branding-sinks.js` 25 → 47 (its control is now the GA4 loader; [6] a legacy payload injects nothing on
    three normal pages; [7] every loader refuses bad values, each with a passing control); `test-admin-panel.js`
    +10 ([8] the type predicate in both statements, [8b] the two admin pages); `test-admin-guards.js` +2 (the keys
    stay deleted). **Mutation-checked:** with the four product files reverted to HEAD, `test-branding-sinks.js`
    fails 18 and `test-operator-code-sinks.js` fails 49 (controls still pass). **Not done:** no browser probe of
    `ads.html` or `settings-analytics.html` (checked statically), nothing ran on a VPS.
12. **C9 must:** create a banner and a text ad and see both rotate; `POST /api/admin/ads` with `ad_type: "code"`
    → 400 naming D22; on a pool upgraded with a stored `custom_head_html`, confirm `/api/public/branding` has no
    such key and Settings → Analytics shows the one line; GA4 still records a page view, address scrubbed.

**Part C2 — the Community header group, games default on, the launch state (2026-10-04; not VPS-tested).**
The contract is §19.17.2 (launch state, truth table), §19.17.8 (header group) and D30/D31. Pool front + back end,
games service, the admin panel and the menu-P bash lib. What the build added to, or found beyond, the prompt:

1. **The rule lives in two copies, and a test holds them together.** `effectiveMode(pool, launch)` is in
   `play/server/lib/mode.js` and, copied (D5: never a require), in `back-end-pool/lib/games-link.js`. Both read
   an unknown pool mode as `off` (own-property lookup, so `constructor`/`__proto__` cannot pass) and any launch
   value but the exact string `on` as `preview`. `test-games-link.js` runs both over a 9 × 9 input grid,
   junk included, and fails on any disagreement.
2. **Games side: a wrapper, not a rewrite.** `createLaunchState({ db, admin, poolMode })` reads `meta.launch`
   live on every call (one primary-key row — a restore or a second admin tab can never leave the process on a
   stale answer); `withLaunch(poolCache, launch)` gives every consumer the same `{ get, isOff }` it always used,
   now returning the effective mode, with `chat_enabled` forced false when effective is `off`. `app.js` builds
   the admin router first (the launch routes register on it) and hands the wrapper to auth, chat, the rules and
   `publicRoute()`. The raw cache stays reachable as `mode.pool()` for the Overview.
3. **What the launch state changes on the games side: nothing a player can see today.** The launch can only
   LOWER the pool's mode, never raise it; and the games service treats `preview` and `on` alike (both serve
   every public route — §19.1 D12's difference is the nav). So `publicRoute()` still 404s exactly on the pool's
   `off`. The state matters for the pool's nav now and the bubble (C7) later. Recorded so R1 does not look for a
   games-side preview behaviour that the design never asked for.
4. **A fresh DB writes `launch = preview` in the v1 migration's own transaction** (beside `created_at`; `ON
   CONFLICT DO NOTHING`). That is code next to a migration, not migration SQL, so the "SQL is never edited after
   it shipped" rule holds and the §19.4 schema contract is unchanged (no new table or column). An upgraded DB
   has no row and reads as preview — the same answer, so no migration was needed.
5. **Health gains `launch`, nothing else.** The plan's prompt said health should report "`launch` and the
   effective mode"; §19.17.2 (the contract) says health gains `launch` and the **pool computes the effective
   mode itself** — the pool's own setting is authoritative, while the games' cached copy of it can be ten
   minutes old. §19 wins: health is `{ ok, net, schema, launch, uptime_s }`. It is read in the same try as the
   schema version, so a DB that stopped answering is still a 503.
6. **Pool side: the probe records the launch, and a LAUNCH flip flushes the branding memo too.** `probe.launch`
   is `null` while unhealthy (the flag is off anyway) and is forgotten on a wrong-network answer.
   `onHealthChange` now fires on a health flip **or** a launch flip while healthy — the callback keeps its name
   (index.js wiring and its test are unchanged); its comment says it means "the flag may have moved". An
   unchanged answer flushes nothing (tested).
7. **Beyond the prompt: Go live shows in seconds, not at the next 60 s tick.** After the admin proxy relays a
   `POST launch` that games answered 200, it fires one `probeOnce()` — not awaited, so "no request handler awaits
   the probe" still holds (that test is unchanged and passes). A GET or a refused POST re-probes nothing.
8. **The admin routes.** `GET /internal/admin/launch` → `{ launch, pool_mode, pool_chat, effective }`;
   `POST /internal/admin/launch { state }` with exactly one key, `preview` | `on` (`off` is refused — it is the
   pool's switch), body ≤ 256 B. Step-up by the fail-closed rule on BOTH sides (no `FAST_WRITES` edit);
   one `mod_actions` row `launch` / target `launch` / `{ from, to }` per real change, inside the same
   transaction as the write; the same state again is 200 with `changed: false` and no row. The pool's step-up
   audit row (`games_admin`) comes from the proxy as for every step-up path.
9. **Admin UI.** Games → Overview gets a **Launch** card above *Pages*: three badges (*Players see*, *Launch
   state*, *Pool master switch*), one explanatory line for the four reachable combinations, and one button —
   **Go live** in preview, **Back to preview** once live — behind the in-page confirm dialog (copied from
   `games-chat.html`) and then the pool's step-up. Built with `G.el`/`textContent` only (the games-admin rule).
   Settings → Games: the mode help text now explains the two switches; its status line gains *launch state*
   (from `/api/admin/games-link`, which now carries `launch`).
10. **Pool defaults `games.mode = 'on'`, `chat_enabled = true`**, with the old "OFF on purpose" comment replaced by
    D30's reasoning. **A SAVED Settings → Games row still overrides the default** — `getSection()` layers stored
    rows over defaults, and a row exists as soon as the page has been saved once; tested ("a SAVED row overrides
    the default"). **C9 must check the live pool's stored row**: if the operator ever saved `off`, the default
    change does nothing there. *Restore Defaults* on that page now restores `on` + chat on.
11. **Header (§19.17.8).** `NAV`: the group is `Community` (👥 — the 🎁 was the prize pool's; it stays on the
    footer's Fortune Board link), children Fortune Board + Contribute (`incentives: true`) and Play
    (`games: true`); the standalone Play item is gone. Gates moved from the group to the children:
    `gateAttrs()` (was `gamesAttrs()`) writes `data-incentives` or hidden `data-games` on each link; a group with
    any gated child gets `data-nav-gated`, and starts hidden only if every child starts hidden. `branding.js`
    gains `applyNavGroups()`, run AFTER `applyIncentivesNav` + `applyGamesNav`: it shows a gated group while at
    least one of its links is shown and hides it otherwise — re-evaluated on every apply, not latched. Neither
    flag function touches the group any more. Side effect, wanted: Community is now the nav's **last** child, so
    the existing ≤ 640 px rule `.nav-group:last-child > .nav-dropdown { right: 0 }` opens it leftward on a phone.
    The active state needs no change: on `/play/`, `fileOf('/play/') === '/play/'`, so the group lights.
    Footer: Play stays in the Pool column with its `data-games` (Fortune Board + Contribute were already skipped
    there and live in the brand column with `data-incentives`).
12. **Menu P (bash, display only — no bash writes a pool setting).** The post-install hint now says a new games
    DB starts in preview and points at Go live; P → 5 Status labels the pool's value *Pool mode* and adds a
    *Launch* line parsed from the health answer it already fetched. `bash -n` clean.
13. **Self-review — every place that still reads the RAW pool mode, justified:**
    - `games-link.js handleConfig` → `/internal/games/config` sends the raw pool settings to games: by design,
      games combines them with its own launch state (§19.17.2).
    - `games-link.js status()` → `/api/admin/games-link` reports raw `mode` / `chat_enabled` **beside**
      `launch` and the effective `public_mode`: an admin view of both inputs.
    - `games-link.js publicFlag()` reads the raw setting only as the input to `effectiveMode()`.
    - `mode.js createModeCache` (the pool-mode cache): its transition log line now says "the pool's games
      mode" so a log reader does not take it for the effective one.
    - `mode.js createLaunchState view()` → the Overview's *Pool master switch* badge: an input, shown as one.
    - `menu P → 5 Status` prints the raw pool mode, now labelled *Pool mode*, beside *Launch*.
    Everything a visitor or player meets reads the effective mode: `/api/public/branding` (`cfg.games =
    publicFlag()`), `applyGamesNav`, and on the games side `publicRoute()`, `auth.chatStatus`, `chat.read` and
    `/play/api/rules` (all through the wrapper). `grep` found no other reader of `getSection('games')`.
14. **Verified:** pool `npm test` **2662 → 2693**, 0 failed — `test-games-link.js` 181 → 212 ([7] the new
    defaults + a saved row overriding them; [8] rewritten: no-`launch` health reads preview, the launch flip
    flushes branding, junk launch values, the whole truth table through the real `publicFlag()`, the two
    `effectiveMode` copies agree; [9] `POST launch` is step-up, re-probes once on 200, not on GET or 400; [13]
    the NAV shape plus a **behavioural** nav matrix — the real `NAV`, `gateAttrs`, `groupAttrs` from
    `public-shell.js` and the real `apply*` functions from `branding.js`, run on a small fake DOM over all six
    incentives × games rows, the pre-fetch state, and a hidden → shown re-apply); `test-public-leakage.js`'s
    `publicFlag` shape check accepts `{ mode, chat }` in shorthand. Games `npm test` **1010 → 1060**, 0 failed —
    NEW `scripts/test-launch.js` 50 (truth table, stored-value parsing, the wrapper, routes 404 only on effective
    off, health, the admin routes: step-up, strict body, audit, idempotence); `test-skeleton.js` health shape.
    **Mutation-checked:** reverting `publicFlag` to the raw mode and making `applyNavGroups` a no-op fails 14
    pool checks; handing the raw cache to the games consumers fails 1 games check (item 3 is why only one).
    **Not done:** no browser render of the header or of the Overview card (checked statically + the fake-DOM
    matrix), nothing ran on a VPS.
15. **C9 must:** on the live pool read the stored `games` row first (a saved `off` stays off); install/update
    games and see /play/ answer by URL while the header shows no Play; Go live → Play appears under Community
    within seconds on a fresh page load; Back to preview → it leaves; incentives off + games live → Community
    holds only Play; both off → no Community group at all; on a 390 px phone the group opens leftward.

**Part C3 — names v2: auto-checked nicknames, the pool-owned blocked-word list, schema v4 (2026-10-04; not
VPS-tested).** The contract is §19.17.5 (D27, D28) and threat notes #24/#25. Games service, the /play/ shell, the
pool back end and the admin panel. What the build added to, or changed against, the contract and the prompt:

1. **One rule, two copies, one fixture — and a code-identity test on top.** `play/server/lib/name-rule.js` and
   `back-end-pool/lib/name-rule.js` are pure (no state, no I/O) and identical from `const NAME_MIN` down; only
   their headers differ. Both suites run every case of `play/server/scripts/fixtures/name-rule.json` (75 cases,
   40 innocent names, 40 adversarial — the contract's ten innocents among them; R1 adds its 30). The pool's
   `test-name-rule.js` also compares the two files' code **line for line** — a stronger check than the fixture,
   which only sees the inputs someone thought of. Mutation-checked: changing one constant in the pool copy fails
   3 pool checks; dropping `badminton` from the games copy's exceptions fails the games innocent list.
2. **The Scunthorpe rule, as built.** An entry of ≤ 4 characters matches the WHOLE name, tested on **two** forms:
   the name with leading/trailing digit runs stripped then folded (`Mod1` → `mod`), *and* the whole name folded
   (`A55` → `ass`). The contract named only the first; stripping first turns `A55` into `a` and `5hit` into
   `hit`, so a leading or trailing leet digit would have walked past every short word. Both forms are equality
   tests, so no innocent name pays for it. ≥ 5 characters match as a substring unless every occurrence sits
   inside an `EXCEPTIONS` word (matched as a substring too, so `prickl` covers prickly/prickle): `badminton`,
   `staffy`, `staffie`, `stafford`, `therapist`, `snigger`, `retardant`, `prickl`. `*` / `=` override.
3. **The seed.** `SEED` = the pool's `STARTER_BLOCKLIST` word for word (tested), with **`*fuck` and `*jizz`
   forced to substring**: no innocent name contains either, and whole-only would let `FuckYou` by. Every other
   ≤ 4-letter seed word stays whole-only on purpose — `shit` (Kshitij, Shitake), `cock` (Peacock, Hancock), `dick`
   (Dickens), `rape` (Grape), `anal` (Analyst), `coon` (Raccoon), `spic` (Spice), `pedo` (Torpedo). **Known,
   accepted limit for R1 to judge:** `ShitHead`, `DickFace` pass. The operator can add `*shit` and pay the
   false positives; the moderators can remove what slips through. The fold covers the contract's six leet
   digits only (no `8`→b, `vv`→w, `ph`→f).
4. **Shape keeps "at least one letter"** (Part 12's rule, not in §19.17.5's text): an all-digit name reads as a
   number on a leaderboard. `name_no_letter` is a shape refusal, so it explains itself. **Address-like is
   "starts with"** `grin1`/`tgrin1` as the contract says (Part 12 refused it anywhere in the name).
5. **Answers.** Shape: `400 name_length|name_charset|name_no_letter|name_invalid` + `hint`; address-like:
   `400 name_address` + `hint`; reserved / blocked: `400 name_not_allowed`, **no hint, byte-identical whatever
   the list** (tested); banned / taken: `409 name_unavailable` (the same body for both, tested); `409
   unchanged`; `403 nickname_refused { reason: cooldown | nick_blocked | <chat-gate reason>, available_at }`;
   `403 nicknames_off`; `429 too_many_refusals` + `Retry-After` to the next UTC midnight. `nickname_taken` and the
   withdraw route are gone. **Which refusals count toward the 10/day cap:** not-allowed and unavailable (the two
   that could probe a list). Shape and address refusals explain themselves and do not count; neither does a
   gate refusal. The cap is checked BEFORE the rule, so the 11th attempt is refused even for a good name, and
   the counter is written in its own transaction because the request is about to fail. The refused text is
   stored nowhere (tested).
6. **Order inside `submit`:** session → gate (switch, `nick_blocked`, the chat bar minus the chat switch,
   cooldown) → shape → `unchanged` → refusal cap → rule → banned → taken → one transaction (old live row →
   `replaced`, new row inserted as `approved`, `players.nick_changed_at = now`). A case change of your own name
   is a change (taken excludes your own address). A `UNIQUE` error from `uq_nick_norm` is answered
   `name_unavailable`; the handler is synchronous, so two simultaneous requests serialise and the second sees the
   first through the ordinary check — the index is the guarantee, the catch is the fallback, and only the
   index's refusal is tested directly.
7. **Cooldown** (`nickname_change_days`, games setting, default 7, 0–90): counted from the last OWN change. A
   removal by the player, an admin or a moderator does **not** reset it — a player whose name was removed waits
   out the rest of the week with the mask, which is also the brake on "set an offensive name, get it removed,
   set the next". Removing your own name needs only a session (allowed while muted, blocked or in cooldown).
8. **Moderator route — changed against the contract.** §19.17.5 sketched `POST /play/api/mod/nickname/remove
   { target }`. Built as **`POST /play/api/mod/messages/:id/remove-name { reason? }`**, keyed by a message like
   `mute`: a moderator never holds a full address (D21's views are masked), so a `target` address is something
   the UI could not even supply. Same protections as mute (operator message, another moderator, own message →
   403 `mod_protected`), same 120/h bucket, one `mod_actions` row `nickname_remove` as `mod:<address>`. The
   chat row and the moderator queue show **Remove name** only on a label that carries a nickname.
9. **Admin routes as built** (all via `admin.add`, all step-up — `FAST_WRITES` unchanged on both sides, tested
   on both): `GET nicknames?state=live|removed&q=` (q = a name fragment, folded, or an address start; `%`/`_`
   literal; ≤ 64), `POST nicknames/:id/remove`, `GET banned-names`, `POST banned-names {name, reason?}` (bans the
   matching form — anything folding to 1–32 of a–z 0–9 — and removes its holder in the same transaction),
   `POST banned-names/:norm/unban`, `GET nick-blocked`, `POST players/:addr/nick-block {reason?}` (creates the
   player row if needed, removes the live name), `POST players/:addr/nick-unblock`. Every live row carries
   **`hit`**: what the rule would answer today. A word added after a name went live is **hinted, never applied
   by itself** — removing a live name is a human decision; the admin page shows "Now refused by …".
10. **Schema v4 as built (§19.4 is the binding text):** `banned_names (norm PK, name, banned_at, banned_by,
    reason)` — `banned_by`, not the sketch's `by` (a keyword); players gains `nick_blocked` (CHECK 0/1),
    `nick_changed_at`, and **two columns the sketch did not have**, `nick_refused_day` + `nick_refused_n` (the
    refusal cap survives a restart, as Part 12's submit limit did), plus a partial index for the blocked list.
    The migration gained a **data step** (`run(raw, now)`, same transaction as its SQL): Part 12's rows are
    re-checked with the seed + reserved words + the chat word list (the pool's half is not known at migration
    time) — live failing → `removed` / `rule_v2`, pending passing and untaken → `approved` (an older live row →
    `replaced`), pending taken → `rejected` / **`taken`** (the contract named only `rule_v2`), pending failing →
    `rejected` / `rule_v2`; `decided_by = 'system'`. Tested on a hand-built v3 file.
11. **The pool's half of the lists (D28).** Pool: a new `names` settings section, `blocked_words` (empty
    default — the seed applies anyway), a textarea on the new **Settings → Names** page; the validator folds each
    line to the matching form, keeps `*`/`=`, drops duplicates, caps 500 × 32, and **refuses** (with the line
    number) an entry that can never match a name, rather than dropping it silently. The section is **step-up**:
    emptying it is how a stolen session would let offensive names go live unseen. `/internal/games/config`
    gains `blocked_words` (re-filtered on read, ≤ 500) and `pool_name` (`pool_info.pool_name`); an unreadable
    names section OMITS both rather than sending an empty list. Games: `pool-link.config()` passes them on
    (malformed → dropped, never fatal to the mode fetch); `createModeCache({ onConfig })` hands every
    successful answer to `names.updatePoolLists()`, which persists a change in the games `settings` table under
    `pool_name_lists` (outside `SPEC`, so the settings reader and the admin form never see it) and reloads it at
    boot. Old pool + new games: no fields → the games keep their copy. New pool + old games: extra fields ignored.
12. **Display unchanged** (`names.label`): `Nick (grin1abcd…wxyz)` or the mask. `/me`'s `nickname` lost
    `pending` and gained `can_remove`, `change_days` and `refused.by` (`pool` | `moderator` | `rule`).
13. **Not in this part:** guests (C5 — sign-up names, `Nick · guest`, the login-name uniqueness rule), donor
    names (C4 — the pool copy's `check()` is unused at runtime until then; only `matchForm` serves the
    validator), the `plays_balance_cap` 999 change (§19.17.9 lists it; it lands with the guest tickets).
14. **Self-review against #24/#25.** #24: the copies cannot drift unseen (fixture + code identity on the pool
    side, fixture on the games side); every uniqueness, ban and word check compares the matching form — `submit`
    uses the rule's `norm`, the ban route folds its input, `banned_names` and `uq_nick_norm` are keyed on it,
    and the v4 migration rewrites a passing pending row's `norm` from the rule. #25: the 40-name innocent list
    passes in both copies; what it cannot promise is item 3's limit, recorded rather than fixed.
15. **Verified:** games `npm test` **1060 → 1111**, 0 failed — `test-names.js` rewritten (81 → 117: [a] the
    fixture, Scunthorpe, entry parsing; [b] every gate, live at once, cooldown, the generic answers, the
    refusal cap; [c] lists, search, remove, ban across spellings, unban, block; [d] the pool lists applied,
    persisted, kept across a rebuild, and the real `pool-link` against a loopback "pool"; [e] the moderator
    route and its three refusals; [f] display, two simultaneous submits, the index, a player ban; [g] retention,
    query plans, the leakage scans); `test-skeleton.js` v4 + the v3 → v4 data migration (156 → 169);
    `test-shell.js` +2. Pool `npm test` **2693 → 2719**, 0 failed — NEW `test-name-rule.js` 20,
    `test-games-link.js` +4 (the config payload), `test-admin-panel.js` [15] rewritten (+2).
    **Not done:** no browser render of the Nickname fold, the moderator button or the admin pages; nothing ran
    on a VPS.
16. **C9 must:** set a nickname on /play/ and see it in chat at once; hit a seed word and a pool word (generic
    answer); add a word on Settings → Names and see it refuse within a minute, and the hint appear on Games →
    Nicknames for a live name it hits; ban a name and try two spellings; block and unblock a player; as a
    moderator, Remove name from a chat message; restart the games with the pool stopped and see the list kept.

**Part C4 — donor names auto-checked (2026-10-04; not VPS-tested).** The contract is §19.17.6 (D29). Pool only,
plus one option in the shared rule that the games copy carries so the two stay one code. Banners are untouched. What
the build added to, or changed against, the contract and the prompt:

1. **The donor shape is an OPTION of the shared rule** (the C3 note said so): `check(name, { shape: 'donor' })` = §18.5's
   set (2–32 of `A–Z a–z 0–9 space - _ . & '`, ≥ 1 letter or digit, ASCII whitespace collapsed) + §16.4's reserved
   words (`DONOR_RESERVED`: admin, official, operator, support, staff, pool, grinium, prize, jackpot, winner; no `guest`
   prefix). The matching form, the Scunthorpe rule, the seed and the operator's list are the nickname's. Both copies
   stay identical (`test-name-rule.js` [2]); an unknown shape THROWS rather than fall back to the looser one.
   `donor-profiles.validateName` now takes its shape from the rule (one definition), so a `null`/`undefined` name
   answers `name_invalid` (it was `name_length`). The fixture gained 37 cases (34 with the donor shape), 30 donor innocents and 28
   donor adversarials; both suites run them.
2. **Departure R1 must judge — a separated WORD counts as "whole".** For a name with separators (only donor names have
   any), `wholeForms` adds each word's two forms, so a ≤ 4-character entry also matches one word of the name:
   `Big Ass Rigs`, `Moon Boys`, `Acme Pool Fans` refuse; `Classic Rigs`, `BobsPool` pass. The contract says "the
   whole name"; a word boundary the donor drew is the name's own, so an equal word IS the word. No nickname verdict
   changes (a nickname has no separators). **Known, accepted limit:** `Moby Dick` refuses (a short seed word as a
   separate, innocent word) — in the fixture, labelled.
3. **Three EXCEPTIONS added (both copies): `cooperator`, `supporter`, `breadwinner`.** `operator`, `support` and
   `winner` are ≥ 5 letters, so substring-matched: without them `Grin Supporters` and `Cooperator` refused. The
   nickname rule gains the same three (fixture cases).
4. **Order — what runs before the proofs and what after.** Before (cheap, reads no list): donations off → account →
   blocked → not a donor → shape → `409 unchanged` → the 7-day limit (`429 name_cooldown` + `available_at`) →
   `400 name_address`. After both proofs: reserved / pool name / seed / `names.blocked_words` → `400 name_not_allowed`;
   banned or taken → `409 name_unavailable` (one body for both). §18.11 Part 2 #4 put the input before the proofs so a
   typo never spends a proof attempt — still true for every refusal that explains itself — but a word-list answer
   before the proofs would let anyone holding the (public) address probe the operator's list. The owner can probe it
   at the `withdraw` rate; there is **no 10/day refusal cap** as the games have, because every probe costs both aged
   proofs. Recorded for R1.
5. **Live at once, one transaction:** gate → the precheck again (the proof check awaits in between) → rule → banned →
   taken → a pre-C4 pending name (if any) and the previous approved → `replaced` → INSERT `approved` (`decided_by`
   NULL = the automatic check, `decided_at = submitted_at`). The route answers `status: 'approved'`.
   `uq_donor_req_approved` stays the race guard; a real constraint hit is `conflict` (tested with a trigger). A refused
   name is stored nowhere: the owner-proof audit row records the proof as ok with `refused: <code>` — never the text
   or the list.
6. **Taken** = another address's APPROVED name — expired included, it returns with the next donation — with the same
   matching form; a case change of your own name is a change. A scan of the approved name rows (one per donor), not an
   index: the matching form is the rule's JS, and a unique index on it would refuse the pre-C4 collisions the contract
   keeps.
7. **The 7-day limit** (`NAME_CHANGE_DAYS`, a code constant as the contract asks) counts from the newest own name row
   that was ever live or submitted (`approved` / `replaced` / `removed`). An admin removal keeps that row's
   `submitted_at`, so it does not reset the clock (as the games' cooldown, §19.15 *Part C3* #7). `unchanged` spends
   nothing. `donor_profile.name.change_available_at` (null = now) is new on `/api/account/:addr`.
8. **Ban table — `banned_donor_names (norm PK, name, banned_at, banned_by, reason)`, the pool's own, not one table
   with a scope column:** the pool has exactly one name namespace — game nicknames are banned in the games' DB (D5) —
   so a scope column would hold one value forever. A ban folds the admin's input (1–32 a–z 0–9), removes every live
   holder in the same transaction (the reason is shown to them) and writes ONE audit row (`donor_name_ban`, target
   `donor_name` / the form, holders listed). Unban restores nothing.
9. **Admin routes (new):** `GET /api/admin/donors/names?state=live|removed&q=` (secureAdmin; a live row carries `hit`
   — what the rule answers TODAY — plus `banned`, `same_as`, `blocked`, `approved_by`: a word added after a name went
   live is a HINT, never applied, as in C3), `GET /api/admin/donors/banned-names` (secureAdmin),
   `POST /api/admin/donors/banned-names {name, reason?}` and `POST …/banned-names/:norm/unban` (freshAdmin). Remove
   and block are the §18.6 routes. `GET /api/admin/donors/requests` gained `?kind=`; the page asks for banners.
10. **Admin page `donors.html`:** the **Banner review queue** (no Flags column — `adminQueue` no longer computes the
    §18 flag hints), a new **Donor names** section (Live / Removed / Banned, Remove · Ban name · Block, a Ban-a-name
    form, the hints), and the flag-word textarea gone (a line points at Settings → Names). Settings → Names, the
    Overview tile ("Donor Banners (to review)") and the nav-badge title follow.
11. **`donor_name_blocklist` retired** into `RETIRED_KEYS` (never read back; a write is refused with a pointer to
    Settings → Names). `PoolSettings.retireDonorNameBlocklist()` runs at every start: it reads the RAW row, keeps the
    entries that do not fold to a starter word, passes each through the names validator (one that can never match a
    name is skipped and logged; overflow past 500 is logged), and merges them in ONE transaction with the row's
    DELETE — the deletion is the "once" marker, so a word the operator later removes never returns. A carried entry
    gets the DEFAULT matching (v1 matched substrings only to flag a name for a human); the operator can add a `*`.
    `donor-names.js` lost `RESERVED`, `normalise`, `parseList`, `poolNameEntry`, `matchEntries`, `nameFlagContext`,
    `nameFlags` and `donorSettings().listText`; it keeps `STARTER_BLOCKLIST` as the record the carry-over and the
    SEED test read.
12. **Migration (startup, after the carry-over, idempotent):** each pending name, oldest first, through the same check
    minus the 7-day limit → `approved` by the system (the previous approved → `replaced`) or `rejected`. The reason
    stored is a sentence ("…did not pass" / "…is not available"), not the contract's `rule_v2` code: a reject reason
    is SHOWN on the account page. One system audit row per decision (`donor_name_auto_v2`). Approved names are kept;
    the list's `same_as` flags any pre-C4 collision. A failed run is logged and retried at the next start — mining
    does not wait for it.
13. **Fixed beside it:** `adminQueue` selected the approved rows without `id`, so in the Approved history view a row
    was shown as "replaces" itself.
14. **Copy:** donate D-01b (names checked at once, banners reviewed, the 7-day limit), the D-03 disclaimer and the
    expiry-0 line; the account P-09 panel (lead, "Set this name" / "Change the name", the next-change line, the
    success line, the demo profile); `API_DOC_META` for the name route, the DELETE route, `/api/account/:addr` and
    `/api/pool/donors`. **CMS defaults:** no seeded CMS page mentions donor-name review (searched), so no operator
    note is owed.
15. **Self-review (#24, #25, banners).** #24: the donor option is in both copies — mutation-checked: dropping `prize`
    from the games copy, and `supporter` from the pool copy, each fail the pool suite. #25: the 30 donor innocents
    pass; item 2's limit is recorded. Banners: `submit` / `insertPending` / `submitBanner` / `approve` / `reject` /
    `withdraw` / `removeLive` / `block` have no hunk in the diff, and a test asserts a banner still lands pending and
    reaches no public view.
16. **Verified:** pool `npm test` **2719 → 2795**, 0 failed (28 suites; the C4 checks sit in `test-donor-profiles.js`
    — names v2, bans, migration, the names list, route order —, `test-donor-names.js` — the carry-over; its matcher
    tests went with the code —, `test-name-rule.js`, `test-public-leakage.js` §9 and `test-admin-panel.js` [9]).
    Games `npm test` **1111 → 1114**, 0 failed. **Not done:** no browser render of the Donor names section, D-01b or
    P-09; nothing ran on a VPS.
17. **C9 must:** set a donor name and see it on the wall at once; try a seed word, a Settings → Names word and another
    donor's name in leet (one generic answer each); change it again inside 7 days (refused, with the date); ban it in
    another spelling (gone from the wall, the reason on the account page) and unban; on the live pool, find the
    carry-over line in the first start's log and the old flag words on Settings → Names.

**R1 review — independent review of C1–C4 (2026-10-04, a cold session that built none of it; code
review + one-shot local probes on Windows, nothing run on a VPS).** Read: §19.17 in full, §19.13 #22–#25, the
four delta notes above, and the working-tree diff of `web/07_mining_pool_public/` against `HEAD` (the tree
also carries the unrelated §20 node-availability work; it was left alone). Baseline before any edit: pool
`npm test` **2795** passed / 28 suites, games **1114** / 9 suites, 0 failed — the C4 totals, reproduced
(one pool suite prints "42 ownership-gate checks passed" instead of "N passed"; a sum that misses it reads
2753 / 27).

*Threat notes.*
- **#22 — Option B: D22's own sinks CONFIRMED gone; the note as written is NOT complete, because of D22-4.**
  Every `createElement('script'|'iframe')`, `innerHTML`, `insertAdjacentHTML`, `outerHTML`, `document.write`,
  `srcdoc`, `cloneScript`, `DOMParser`, `new Function` and `setAttribute('on…')` in `public_html` and
  `play/shell` was grepped and the script creators read: the four provider loaders build only from a value
  that passes a strict pattern (re-checked in `branding.js`; the GA4 init text is built with `textContent`
  and `JSON.stringify`), the JSON-LD block is a data type filled with `textContent`, the ads loader is a
  fixed path, the frame is `sandbox="allow-scripts"` on a fixed path. `ads.js` renders only `banner` /
  `text`, attribute-escapes every value and re-checks both URLs; a legacy `code` row is excluded by one
  `SERVABLE` predicate in both the serving and the counting statement, and `html_code` leaves `lib/ads.js`
  nowhere, admin included. `RETIRED_KEYS` is applied in `getSection()`, and no other reader of `pool_config`
  touches the `analytics` section (every raw `FROM pool_config` in the backend was listed), so a stored
  custom-HTML value reaches no browser. The innerHTML templates that carry fetched text were spot-read —
  the donor wall (`donate.html` `nameCell`/`spotCard`/`pastRow`) and the account donor panel (`dpLine`) both
  escape, which matters now that a donor name with `&` or `'` goes live without a human. **Still open:**
  **D22-4** (§19.15 *Part C1* item 10, audit roll-up) — `page.html` / `post.html` set operator HTML with
  `innerHTML`; confirmed by reading both pages and `lib/pages.js` / `lib/posts.js` (the server-rendered
  head emits only metadata, so there is no second copy of the sink). Not fixed here: the three remedies C1
  listed are a product decision, and D22's own reasoning argues against a sanitiser. **It must be decided
  before C7**, which puts the sign-in bubble on both pages.
- **#23 — Effective mode: CONFIRMED.** All 32 public routes are registered only through the route arrays
  `app.js` passes to `publicRoute()` (enumerated from the seven modules' `routes`); health is the one
  `router.add` outside it, by design, and the admin routes sit behind `admin.js`'s guard. `publicRoute()`
  404s on the effective `off`; `withLaunch()` can only lower the pool's mode; the games cache reads `off`
  > 10 min after the last good fetch; the pool's `publicFlag()` reads `off` whenever the probe is unhealthy
  and computes `min(pool, launch)` itself. Go live is step-up on BOTH sides (not a `FAST_WRITES` path on
  either; the proxy's `PROXY_PATH_RE` leaves no encoded or dot-segment way round the anchored patterns),
  idempotent, and its one `mod_actions` row is written inside the write's transaction. The raw-mode
  readers C2 #13 lists in `games-link.js` (`publicFlag`, `status`) and `mode.js` (the pool-mode cache, the
  Overview `view`) were re-read and none reaches a visitor; menu P's bash line was not re-read. **Observation, not a finding:**
  `/api/public/branding` is `Cache-Control: public, max-age=60`, so the C2 re-probe moves the SERVER's
  answer in seconds but a browser that fetched the payload in the last minute keeps the old nav until it
  expires — C9 should expect "≤ 60 s", as the plan's checklist already says, not C2 #15's "within seconds".
- **#24 — Name-checker parity: CONFIRMED.** The two copies are identical below the header (diffed; the pool
  suite's line-for-line test agrees), both run the whole shared fixture, and R1 ran all of it through both
  copies side by side: 250 inputs before the fixes and 343 after, 0 disagreements. Every uniqueness, ban and
  word check compares the matching form (games `submit` uses the rule's `norm`; both ban routes fold their
  input; `banned_names`, `banned_donor_names` and `uq_nick_norm` are keyed on it). Under a race the games
  guarantee is the partial unique index `uq_nick_norm` (in `db.js`, as §19.4). **The donor side has no
  cross-address index** (C4 #6: the matching form is JS) — its guarantee is that `submitName` runs as ONE
  synchronous transaction in the pool's single process, so two submits cannot interleave; accepted, and
  recorded so a future multi-process pool knows to revisit it.
- **#25 — Scunthorpe: CONFIRMED after R1-2.** R1's own 70 innocent names (towns, surnames, common words
  holding a short word) and 64 adversarial ones (leet, mixed case, digit padding, reserved words inside
  longer names, address-likes, the pool's name) were run through both copies: 62 of 64 refused, 67 of 70
  passed. The two misses and three false refusals are R1-2 and R1-3 below.

*Mandatory probes.* (1) and (2) are #22 and #23 above. (3) **Nav — the gating matrix renders right**: a
loopback static server over `public_html` with `/api/public/branding` stubbed per state, and headless Edge
(`--dump-dom` + screenshots, every process ended in the session): all six incentives × games rows
(on/preview/off) at 1280 and 390 px — the group shown with exactly the right children, **hidden** when it
has none, the footer following — **12/12**. A trap worth recording for later probes: headless Edge clamps
`--window-size` to a ~492 px viewport, so a "390 px" screenshot is a 492 px layout cropped, which looks like
the Community caret is cut off. Re-measured inside a real 390 / 360 px iframe: no horizontal overflow, the
Account chip on the brand row, the Community trigger and caret inside the viewport, and the layout equal to
`HEAD`'s apart from the intended change. (4) **Name rule** — #24/#25 above. (5) **Admin/mod powers**:
`modRemoveName` refuses an operator message (or one with no address), the moderator's own and another
moderator's (403 `mod_protected`) inside the transaction, and writes one `mod_actions` row only when a name
was really removed; the games ban / unban / block / unblock / remove are step-up by the fail-closed rule on
both sides, and each writes exactly one row inside its transaction when it changes something (a no-op —
ban of a name already banned with no holder, unblock of a player not blocked — writes none, as Go live's
idempotence does); the pool's donor-name ban / unban are `freshAdmin` with one `donor_name` audit row each.
(6) **Donor banners untouched**: every banner-path function in `lib/donor-profiles.js` — `gateSubmit`,
`insertPending`, `submit`, `submitBanner`, `approve`, `reject`, `withdraw`, `removeLive`, `block`,
`unblock`, `isExpired`, `sniffBanner`, `parseDimensions`, `validateBanner`, `writeBannerFile`,
`unlinkBannerFile`, `requestImage`, `publicProfiles`, `adminProfiles`, `cleanReason` — is byte-identical to
`HEAD` (extracted and compared); only `profileFor`, `adminQueue` and `audit` changed, as C4 says. In
`index.js` no hunk lands in the banner or DELETE handler; the only shared-helper change is `donorRefuse`'s
optional `extra` argument, which the banner route does not pass. (7) Suites below.

*Departures judged.* **C1:** Matomo kept as a fourth provider — accepted (same class: an https origin + an
ID, the same three-layer check). **C2:** health carries `launch` only and the pool computes the effective
mode — accepted (§19.17.2 wins over the plan's prompt). **C3:** the moderator route keyed by a message —
accepted (a moderator never holds a full address); the ≤ 4-character test on two forms — accepted (verified
that `A55`, `As5`, `5hit`, `Cun7` refuse, and both forms are equality tests, so no innocent name pays);
only `*fuck` / `*jizz` forced to substring — accepted as a limit (`ShitHead`, `DickFace`, `CuntFace` pass;
`*cunt` would refuse Scunthorpe, the case the rule exists for); "≥ 1 letter", the v4 extras, the
removal-keeps-the-cooldown rule and hint-only list changes — accepted. **C4:** a separated word counts as
whole — **accepted**: a word boundary the donor typed is the name's own, `Big Ass Rigs` must refuse, and
the cost (`Moby Dick`, a short seed word as an innocent separate word) is small and labelled in the
fixture; the three added EXCEPTIONS, the list / banned / taken answers only after both aged proofs with no
10/day cap (each probe costs both proofs at the `withdraw` rate), the pool-own `banned_donor_names` table
and the migration's reason sentence — accepted.

*Findings (audit roll-up rows R1-1…R1-3).*
1. **R1-1 (Low–Med) — the pool's name stopped being reserved as soon as it held one character outside
   `a–z 0–9` and the separators. FIXED.** `pool_info.pool_name` is free text (no validator), and
   `poolNameEntry()` returned `null` — reserve nothing — whenever the folded name was not pure `a–z 0–9`:
   `Night Owl Mining!`, `Night-Owl (EU)`, `NightOwl ⛏`, `Night Owl™`, `Owl#1` all let a player (and a
   donor) take the pool's name, which then reads as the pool in chat and on the boards. Fix, in both copies:
   strip accents (NFD), fold, then DROP every remaining non-`a–z 0–9` character; the < 3-character floor
   still applies (a pool named in another script folds to nothing and reserves nothing — no ASCII name can
   spell it anyway). Fixture: three new contexts (`punct_pool`, `accent_pool`, `symbol_pool`) and seven
   cases, nickname and donor shape. Mutation-checked: the old `poolNameEntry` fails 6 of them.
2. **R1-2 (Low) — two real words refused by the Scunthorpe rule. FIXED.** `Penistone` (the town) and
   `Supportive` hit `penis` / `support` as substrings. Added `peniston` and `supportiv` to EXCEPTIONS (both
   copies) with fixture cases, plus `SupportiveAdmin` to pin that an exception covers only its own
   occurrence. Mutation-checked: without them both innocents fail.
3. **R1-3 (Info) — residues, recorded as accepted.** `F4ck` / `fvck` pass (a vowel swap: `4` folds to `a`,
   and `v` is not folded — the contract folds six digits only); `Guesthouse` is refused by the `guest`
   PREFIX rule, which exists to protect the `Guest-XXXX` label; impersonation words that are not on the
   reserved list pass (`PoolOwner`, `ModTeam`, `TheMod` — `pool` / `mod` are whole-only by the Scunthorpe
   rule, and `owner` / `team` are not reserved). Post-moderation (admin + moderators, a ban makes it stick)
   is the designed answer to all of these; `F4ck`, `Guesthouse` are labelled cases in the fixture.

*Fixture after R1:* 112 → **124** cases, innocent 40 → **82** (R1's 42 that pass, incl. the two fixed),
adversarial 40 → **79** (R1's 39 that refuse) — §19.17.5's "R1 adds 30 of its own". The suites check the
lists as aggregates, so the totals do not move.

*Verified:* pool `npm test` **2795 → 2795**, 0 failed (28 suites; `test-name-rule.js` now runs 124 cases /
82 innocent / 79 adversarial and still finds the copies identical); games **1114 → 1114**, 0 failed
(`test-names.js` the same). **Not done:** no browser render of the admin pages (Games → Overview's Launch
card, Games → Nicknames, Donors' name lists, Settings → Names) or of /play/'s Nickname fold; nothing ran on
a VPS. **For the operator before C7:** D22-4 (the CMS bodies). **For C5:** `poolNameEntry` is the only
pool-name fold — keep it that way when guest sign-up names are checked.

**Part C5 — guest accounts backend (2026-10-04; not VPS-tested).** The contract is §19.17.3 / §19.17.4 (D24–D26,
D32), threat notes #26–#29. Games service (NEW `lib/guests.js`, NEW `lib/tickets.js`, schema v5, hooks in `auth`,
`sessions`, `chat`, `names`, `matches`, `moderation`, `leaderboard`, `events`, `plays`, `pool-link`, `mask`), one nginx
zone in `07_lib_pool_games.sh`, and the admin pages' player paths (pool static files, no pool backend code). What the
build added to, or changed against, the contract and the prompt:

1. **Guest login is its own route, `POST /play/api/login/guest { name, password }`** — not a `kind` on
   `/play/api/login`. The miner login's body schema is exact-key and it is the one handler that calls the pool; a
   `kind` switch would make every key conditional there. A second handler keeps both schemas exact, and nginx's
   `^~ /play/api/login` is a PREFIX match, so the guest route gets the login zone (20 r/m) and the 4 KB cap with no
   nginx change. A guest body sent to the miner route is still `400 field: body`.
2. **`guests.created_ip_coarse` became a separate table, `guest_signups (id, ip_coarse, created_at)`.** Counting
   sign-ups from the `guests` table, as the sketch had it, lets a delete hand its /24 a fresh slot: sign up, delete,
   sign up — unlimited a day, one PoW each. The log is not linked to the account (no id column), so an IP is never
   stored beside the account it made — better than "NULLed after 7 days" — and rows older than 24 h (all the count
   reads) are deleted by the hourly job. `guests.id` also gained `REFERENCES players(address)`.
3. **The sessions rebuild is copy out → drop → create → copy back**, not "create new → rename": `ALTER TABLE …
   RENAME` stores the new name QUOTED (`CREATE TABLE "sessions"`) in `sqlite_master`, and §19.4 is compared with the
   live schema as text. A v4 → v5 test proves every row and column survives and the stored text is canonical.
4. **The guest chat age gate is recomputed LIVE** from `guests.created_at` in `auth.chatStatus`; the session's
   `chat_ok_after` is still written (sign-up time + the gate) but is a record. So an operator who raises
   `guest_chat_min_age` mid-flood closes chat to guest sessions already open (tested). New refusal reasons:
   `account_too_new` (with `available_at`) and `guests_off`. `guest_chat_min_age`'s SPEC minimum is the 1 h floor.
5. **The PoW is spent at step 3**, before the per-IP limits and the name check: a refused name costs a new PoW. That
   is the point — it makes sign-up a poor oracle for the login namespace — and C6 checks the shape client-side
   first. Refusals carry a reason the client can act on: `invalid` (malformed, forged, bits outside 14–26 even if
   signed), `expired`, `ip_changed` (the caller's /24 is not the one that fetched it), `used`, `insufficient`; none of
   them says anything about an account. The `ip_coarse` part of the token is base64url-wrapped (an IPv4 /24 is full of
   dots). The used set is bounded (50 000) and **fails closed** (`429 busy`) rather than forget a use. A restart
   changes the HMAC key, so a token from before it is `invalid` — precomputation across restarts is useless.
6. **The per-/24 attempt bucket** is 6 an hour (refusals count too), in memory; the 3-a-day success limit is read
   from `guest_signups` and **re-checked inside the sign-up transaction**, because a scrypt await sits between the
   two (two sign-ups from one /24 could otherwise both pass). The challenge route has its own per-IP bucket (20/h).
7. **Passwords** are NFC-normalised before hashing (the same password typed on two keyboards is the same password);
   the rule codes are `too_short`, `too_long`, `charset` (control / format characters), `same_as_name` (any case,
   leet), `common` (a ~40-entry list + one repeated character), `unchanged` (password change). Each refusal carries
   a hint.
8. **A wrong CURRENT password** (change, delete) counts on a per-guest lockout (5 → 5 min, doubling to 6 h), so a
   stolen session cookie is not an unlimited guesser of the password behind it. The password change is a
   compare-and-set on the old hash, so two racing changes cannot both win.
9. **Delete takes `confirm: "DELETE"`** (an exact string; C6's typed confirmation maps to it). A delete also
   **cancels the guest's open seeks and challenges, refunded** (the ledger stays whole; nobody can accept a game
   against an account that no longer exists). Its ACTIVE games are left to their move clocks — it loses on time,
   like anyone who walks away. A deleted guest is not topped up, not ranked (boards, events), and its sessions are
   refused twice: revoked by the delete, and `sessions.lookup` refuses a deleted player.
10. **Admin, guests by URL form `g.<16>`.** A path segment cannot carry `:` (games `PARAM_RE`, and the pool's
    `PROXY_PATH_RE` refuses it before forwarding), so every admin player route accepts `g.<16>` (`mask.js
    playerParam`), and the admin pages build player paths with `GamesAdmin.playerSeg()`. Mute, ban, unban, purge,
    adjust, the player view, the nickname block — all work on guests; **mute stays FAST** (`players/[^/]+/mute`),
    everything else step-up. NEW `POST guests/:gid/delete` (step-up, audited `guest_delete`). A guest id that names no
    guest is a **404** — an admin write must never create a players row for an id nobody holds. The moderator routes
    keep a miner-only parameter with an explicit `isGuestId` refusal (D32).
11. **`Guest-XXXX` is four base32 characters of sha256(id)**, not characters of the id: the id is private (only its
    owner's `/me` returns it), and the tag must not leak 4/16 of it. `maskAddr()` gained the guest branch, so every
    existing mask call (the moderator queue's reporter column, log lines) is safe without a change at the call site.
    `names.label`: `Nick · guest` / `Guest-XXXX` / `deleted guest`.
12. **A guest cannot be challenged directly** — a challenge targets a full pool address (§19.8: the challenger
    already knows it), and a guest has no shareable id. Guests play the lobby's seeks, and may challenge miners. For
    C6 to say.
13. **Guest renames** need a session and nothing more (no account-age wait); sign-up counts as a change, so the first
    rename is 7 days after sign-up. A rename never checks login names (tested: a guest may take another guest's
    login name as a nickname once it is no longer live; sign-up with it is still refused).
14. **`/me`** gains top-level `kind` and, for a guest only, `guest: { login_name, created_at, daily_tickets,
    resets_at, chat_from }` — the only response that carries a login name. **`/play/api/rules`** gains `guests` (the
    daily tickets, the age gate, the pace, the switches) for C6's "How tickets are earned" fold.
15. **Admin settings:** a "Guest accounts" group on Games → Overview, three new floors (`signup_pow_bits` 14, the guest
    age 1 h, the guest pace); the Players page looks up `g:` ids, shows a guest's dates (never its login name),
    disables Appoint, and has **Delete guest account**.
16. **Not done here, for C6:** the API's `no_plays` message still reads "No plays left. Plays come from mining
    minutes." — the visible word and the guest wording are C6's.
17. **nginx:** zone `…_gamesignup` 6 r/m (burst 4) on `^~ /play/api/signup` (the challenge and the POST); the zone
    file is regenerated when it lacks any of the three names. **C9:** run `P → 3` on the box, or the location is not
    there.

*Self-review against #26–#29 (R2 judges; these are the builder's answers):*
- **#26 — answered.** One wording and one body for an unknown name and a wrong password (tested byte-equal); an unknown
  name runs one scrypt against a dummy hash computed at start-up (tested by counting `crypto.scrypt` calls: 1 and 1);
  the ban answer only after the password (a banned guest + a wrong password gets the plain `login_failed`). The
  login namespace is reachable only through sign-up (PoW + attempt bucket + the 3/day limit), and a rename never
  answers "taken" for a login name. The per-name budget counts failures only and lets an IP whose /24 had a session
  for that guest in 30 days through (tested: 20 stranger failures from 20 /24s, then the owner from a known /24 gets
  in, a first-time IP waits). One scrypt cap (4 + 64 waiting, then 429) serves sign-up, login, change and delete.
- **#27 — answered.** Single-use, 5-minute, /24-bound, HMAC-signed; replay, another /24, expiry, a forged bits field,
  a forged IP field, a token under the floor and a token from before a restart are all refused (tested); verifying
  costs one HMAC + one SHA-256 (tested by counting).
- **#28 — answered, with residues.** Guest reports reach the queue and never hold a message (tested: 3 guest reports
  leave it visible, 3 miner reports hold it); guest posts 1 per 15 s and 10 an hour, links always held; the age gate
  makes a flood cost a day per account; `mining_*` events skip guests; `game_results` is bounded by 5 tickets a day;
  PvP Elo by the pair cap; name squatting by the idle job and the sign-up limit. **Residues:** the 3/day/24 limit
  counts per carrier NAT, so many honest mobile users behind one /24 can be refused (the operator can raise it to 10);
  `Guest-XXXX` collides at 20 bits (a label, never an identity); a deleted guest's `players` row is kept forever
  (small, and history needs it).
- **#29 — answered.** `pool-link.verifyProof` refuses a non-pool address with `not_pool_address` before any connection
  (tested against a real client); the activity sync skips a `g:` row (tested with a planted one); the moderator
  routes refuse a guest (tested); `mining_minutes` / `active_days` filter `g:%` (tested with a planted activity row);
  `names.label` covers guests and deleted guests, and the scans in `test-guests.js` and `test-names.js` find no guest
  id, no `login_name` and no bare guest nickname in any public response; the admin player view carries no login name.
  Nothing money-adjacent exists in the games service.

*Verified:* games `npm test` **1114 → 1276**, 0 failed (NEW `test-guests.js` 151; `test-skeleton.js` +8 — the v4 → v5
rebuild; `test-names.js` +3 — a guest in the leakage scan); pool **2795 → 2797**, 0 failed (`test-admin-panel.js` +2 —
the guest path form and its step-up); `bash -n scripts/lib/07_lib_pool_games.sh` clean. **Not done:** no browser
render of the admin pages' guest additions; nothing ran on a VPS.

**Part C6 — the guest UI on /play/ (2026-10-04; not VPS-tested).** The contract is §19.17.3 / §19.17.4 / §19.17.5 (D24–D27).
Shell only: NEW `play/shell/js/play-guest.js` (tabs, guest sign-in, sign-up, the Guest account box, the guest lines of
the fold) and NEW `play/shell/js/play-pow.js` (the sign-up proof-of-work), edits to `index.html`, `play-shell.js`,
`play-chat.js`, `play-lobby.js`, `play-names.js`, `play-api.js`, `play.css`; three sentences in the games `lib/http.js`; one
label in the pool's admin `games.html` (the PoW setting no longer promises "18 ≈ a few seconds" — #1). No schema, no route. What the build added to, or changed against, the contract and the prompt:

1. **The proof-of-work runs in plain JavaScript, not WebCrypto** (the prompt said "WebCrypto SHA-256 in chunks"; §19.17.3
   said C6 measures it). Measured in headless Edge on the dev box: `crypto.subtle.digest` managed **34–38 k hashes/s** — it is
   one promise round trip per hash — so 18 bits took 2.8 s, 4.5 s, 10 s and **25 s** in four runs (the search is
   geometric: an unlucky run is several times the mean), and a phone would be several times slower. `play-pow.js` instead
   hashes the challenge part of the message (always ≥ 64 bytes) once into a midstate and runs only the last one or two
   blocks per try, with the nonce's counter bumped in place: **~570 k/s** in Node, and the full sign-up (challenge + solve +
   POST) took **510 ms** at 18 bits in the Edge probe. No secret is involved, and the server verifies with Node's own
   SHA-256, so a solver bug can only make a sign-up FAIL; `test-shell.js` [5] checks the SHA-256 against Node's on 300
   lengths + the `abc` vector and every answer against the real `createPow().verify`. Time-sliced (40 ms, then
   `setTimeout(0)`), no Worker. The nonce is 4 random base36 characters + an 8-digit base36 counter, always 12 characters,
   so the padding never moves. **The default stays 18 bits** — but at this speed it is ~0.5 s on a desktop, so C9's phone
   timing may well show room to raise `signup_pow_bits` (20 bits ≈ 4× the cost to a sign-up farm).
2. **Sign-up lives inside the Guest tab**, not as a third tab: the card has exactly two tabs (Miner · Guest, a real tablist
   with arrow keys), and "Create a guest account" (in the Guest tab, and a line under the miner form: *"Don't mine here?"*)
   swaps the Guest panel to the sign-up form. **`/play/#signup` opens it** (C7's bubble links there); the hash is set while
   the form is open and cleared on success or "I already have a guest account". The last tab used is remembered per viewer
   (`localStorage grin_play_login_tab`, every access in `try/catch`); Miner is the default.
3. **The name's SHAPE is checked in the page before any request**, with a live hint (`3–20`, letters and digits, a letter,
   not address-like — `name-rule.js checkShape` + the address test). The PoW is spent the moment the server verifies it
   (§19.15 *Part C5* #5), so a shape refusal after it would cost a new one. The hint never says a name is free — "the pool
   checks that nobody has it and that it is allowed". Every attempt fetches a fresh challenge.
4. **Every C5 refusal has one sentence**: `signup_closed` (the form is swapped for the "closed" notice), `pow_failed` by reason
   (`expired`, `ip_changed` — "a VPN, or a phone switching between Wi-Fi and mobile data" — else one generic line),
   `too_many_requests` (`signup_limit` vs the attempt bucket, with the wait), `busy`, `name_not_allowed` / `name_unavailable`
   (the server's vagueness kept: no word, no list), `password_weak` (the server's hint), `name_*` (its hint). Guest sign-in:
   `login_failed`'s own hint, the wait on 429, `banned`.
5. **A card-level note line (`#login-note`) above the tabs** carries why the card is showing (signed out, session ended,
   account deleted). It used to be the miner form's message line, which is hidden while the Guest tab is open — so a guest
   who deleted their account saw nothing. `signedOut(note, kind)`: the player's own sign-out reads as `ok`.
6. **"Signed in as" for a guest is the sign-in name + "· guest"** (from `/me`, its owner only — §19.13 #29); a miner still sees
   the mask. A line under the placard: "*N tickets a day — the count goes back to N at 00:00 UTC (… from now)*".
7. **The Guest account box** (a fold in the account strip, guests only): the sign-in name and creation date, change password
   (current + new twice; "other devices are signed out"), delete (password + typed `DELETE`). The typed word is compared
   case-insensitively in the page and the body always carries exactly `DELETE` (`test-shell.js` compares it with the server's
   `DELETE_CONFIRM`); there is no two-click on top. `wrong_password`, its lockout wait, `conflict` and a gone session each have a
   sentence. Every password box is wiped after every attempt, and no input on the page has a `name=`.
8. **"Tickets" is the visible word everywhere on /play/** (placard, fold title + body, buttons, refund lines, errors) and in the
   games service's own sentences: `no_plays` ("No tickets left. Miners earn them from mining minutes; a guest account gets
   new ones at 00:00 UTC."), `expired` ("The ticket was refunded."), and `banned` now says "This **account**" (it reaches guests).
   `test-shell.js` fails on "plays" / "a play" in the page text or in any sentence a shell script writes. The admin pages keep
   the internal name (§19.17.4 allows "(tickets)" on a label; not added). The out-of-tickets sentence is per kind: a guest gets
   the 00:00 UTC refill and the wait, a miner the mining pointer.
9. **"How tickets are earned"** is rewritten for both kinds, cost first: miners (mining minutes, now "999 held"), guests (the
   daily SET, no saving up, no password recovery, idle deletion), PvP, points, events ("the mining ones are for miners only"),
   chat for both, names for both. The guest numbers come from `rules.guests` (`play-guest.js`), the rest as before.
10. **`PlayApi.rules()`**: one cached `GET rules` per page load, shared by the chat panel, the lobby and the guest forms (it was
    fetched twice before C6 and would have been three times); a failure is not cached.
11. **Chat:** `account_too_new` reads "*You can post from <date> UTC (in …). A guest account has to be <age> old before it can
    post, so nobody can flood the chat with fresh accounts. Reading is open now.*"; `guests_off` "*open to miners only right
    now*"; a guest sees "*a message with a link in it waits for a moderator*" under the form. **When a wait runs out** (account
    age, or a miner's proof age, ≤ 6 h away) the panel fires `play:refresh-me` and the shell refreshes `/me`, so the form
    appears without a reload — before, a miner's `proof_too_new` waited for the 5-minute refresh too.
12. **Lobby:** a guest sees why nobody can challenge them (no address to type) and that they can still challenge a miner;
    "another miner" → "another player", "two addresses" → "two players".
13. **Nickname fold:** a guest sees the `NightShift · guest` example and that changing the nickname never changes the sign-in
    name; "Removed" says what others now see (the server's `shown_as`); `nick_blocked` says "your account".
14. **Not done here, for C7:** the shell does not yet write the bubble's localStorage hints (`grin_play_signed_in`,
    `grin_play_preview`, §19.17.7). They belong to the bubble's contract; C7 adds them to the shell with the bubble.

*Self-review — the copy read once as someone who has never mined and never heard of Grin:* the header says a free guest
account exists before the card does; "tickets" and "points" are explained where they first matter; "proof-of-work" never
appears (the page says "*checking you're not a bot*"); the no-email / no-reset warning sits on the form, not in a fold.
**Accepted:** the default tab is **Miner** (the pool's own audience) — a non-miner sees a "GRIN address" form first, with the
"*Don't mine here? Create a free guest account*" line right under it, and C7's bubble links straight to `#signup`. "GRIN",
"UTC" and "seek" stay unexplained (pool-wide words). *Against #26/#29:* the page repeats only the server's vague answers
(no list hit, no "exists" — one sentence for a wrong pair, including a deleted account); the sign-in name is shown only from the
owner's own `/me`; textContent only, no inline script (test-shell [1]); the page stays `data-untrusted-html="exempt"`, which
now also covers the guest passwords typed on it.

*Verified:* games `npm test` **1276 → 1316**, 0 failed (`test-shell.js` 114 → 154: the tabs, no `name=` on any input, password
boxes, load order + stamps, API paths, the DELETE word, the order "shape before challenge", every refusal code, the events,
`#signup`, storage in try/catch, "tickets" in page + scripts + server, the fold; `rules()` caching; [5] the solver);
pool **2797**, 0 failed (the one pool change is a static admin label). **Headless-Edge probe 95/95** (session scratchpad only; the real games app
in-process on an in-memory DB with a stubbed pool link, the shell under the real `/play/` and `/play/games/` CSP from
`07_lib_pool_games.sh`, 127.0.0.1, Edge and the server killed after): at 1280 and 390 px — `#signup` opens the form; shape
refusals send nothing; a reserved name costs a PoW and is refused vaguely; a good name signs up with a NEW challenge (body
exactly `{name, password, challenge, nonce}`), lands signed in with 5 tickets, the guest line, the welcome; chat refused
with the age wait; a bot game costs a ticket and a real click-move through the sandboxed frame is answered; wrong-then-right
password change; log out (note visible on the Guest tab); guest sign-in in another letter case; typed delete; sign-in after
delete refused; tabs by click and arrow key; no horizontal overflow; 0 console errors / exceptions / CSP violations (the only
console lines are the expected 4xx of the refusals). Plus sign-up closed: the notice, both offers hidden, the fold says so.
*Probe traps for later sessions:* Edge runs the sandboxed game frame OUT of process — it is not in `Page.getFrameTree`;
auto-attach and evaluate in its own session; and a click right after `scrollIntoView` can land on the old position — wait for
a paint. `Emulation.setDeviceMetricsOverride` gives a true 390 px layout (`innerWidth` 390), unlike `--window-size`.
**Not done:** nothing on a VPS; no phone timing of the PoW (C9).

**Part C7 — the floating chat bubble, and D22-4 closed (2026-10-04; not VPS-tested).** The contract is §19.17.7 (D23) and
threat note #30. Games: NEW `play/shell/js/play-chat-core.js`, `chat-bubble.js`, `css/chat-bubble.css`; `play-chat.js`
rebuilt on the core; one script tag in `index.html`; the two hints in `play-shell.js`; `rules.mode` in `lib/app.js`. Pool:
`loadChatBubble` in `public_html/js/branding.js`; NEW `public_html/js/cms-frame.js`; `page.html` / `post.html`. No schema,
no nginx, no setting. What the build added to, or changed against, the contract and the prompt:

1. **D22-4 — the operator's decision, asked before any C7 code: SANDBOX the CMS bodies** (offered: sandbox / exempt the CMS
   pages from the bubble / an allowlist sanitiser / accept). `cms-frame.js` puts a page or post body in a `srcdoc` iframe with
   `sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation"` — **no
   `allow-scripts`**, so no `<script>`, `on*` handler or `javascript:` URL in a body runs, whatever the markup; the browser
   enforces it and there is no filter to keep right (D22's argument against a sanitiser holds). `allow-same-origin` is safe
   only because scripts are never allowed (the pair together would undo the sandbox; the sink test pins both). It lets the
   PAGE reach in: it clones the page's stylesheets, `<style>` blocks and the body/html theme attributes into the frame (and
   re-syncs on a theme switch or a late branding stylesheet), sizes the frame to its content, sets `rel=noopener` on
   `_blank` links and scrolls the page for an in-body `#anchor`. `<base target="_top">` makes a plain link navigate the tab
   (on a user's click only). The frame inherits the page CSP (srcdoc), so a body loads exactly what it could before. A
   body's own CSS now stays inside the frame — before, it could restyle or overlay the whole page, the bubble's sign-in
   included. If `cms-frame.js` fails to load, the page shows a sentence, never an innerHTML fallback. **Accepted costs:**
   a `<form>` in a body no longer submits (no `allow-forms`); search engines see the body inside a frame (the server-rendered
   head — title, description, og — is unchanged); C9 checks one post in Search Console.
2. **The loader is in `branding.js`, not `public-shell.js`** — the decision needs `cfg.games`, which lands there (§19.17.7
   allowed either; the sink test's comment had guessed public-shell). It runs inside `apply()` after the banners, so a page in
   maintenance never gets it, and only when `!isCredentialPage()` (the exempt attribute + the page-key list).
3. **The stamp.** The loader inserts `/play/version.js` (a fixed path) and then `/play/js/chat-bubble.js?v=<GRIN_PLAY_VERSION>`,
   the stamp pattern-checked (12 hex) — a bad or missing one loads the bubble unstamped (`/play/` is no-cache anyway). The
   bubble reuses the stamp it was loaded with for its CSS and dependencies. Cost: one extra small revalidated request per
   page view while chat is on.
4. **Lazy dependencies.** The bubble fetches `play-api.js` + `play-chat-core.js` only when it has something to do (opened,
   or a session hint to poll for), so closed + signed out costs no API request AND no script beyond the bubble's own file
   and stylesheet — stricter than §19.17.7 asked.
5. **One chat client.** `PlayChatCore` holds the feed (the change-feed state machine), the row builder, the gate and error
   sentences and the two-click confirm; the /play/ panel keeps only what is /play/'s (moderator tools, the rules fold, its
   cadence) and behaves as before. `gateText` takes the signed-out sentence ("above" on /play/, "below" in the bubble).
   **Accepted duplication:** the row CSS is repeated under `.gcb` in `chat-bubble.css` (`play.css` is not on pool pages),
   and the bubble's sign-in sentences repeat the shell's mapping — the sign-in cards are not the chat client.
6. **`GET /play/api/rules` carries `mode`** (the effective mode, `preview` | `on`): the shell sets `grin_play_preview` when
   it loads in preview and **removes** it when the games are on (so *Back to preview* hides the bubble again from browsers
   that only saw /play/ live). `grin_play_signed_in` is set in `signedIn` (both sign-in kinds pass through it) and cleared in
   `signedOut`; the bubble sets and clears it too, and clears it on a 401 or a ban.
7. **Unread dot:** `grin_play_chat_seen` keeps the newest id the viewer had open; the first sight is the baseline (no dot);
   a newer visible message from someone else lights it and relabels the button "Open chat — new messages"; your own never.
8. **Sign-out in the bubble** (beyond the prompt): on a shared computer the bubble is the only place on the page that says
   you are signed in. "Sign in to post" is a toggle, so the list stays visible while signed out; the tabs share
   `grin_play_login_tab` with /play/. A successful sign-in clears the typed address / name as well as the password (#30).
9. **Moderators** get a line ("Your moderator tools are on the games page") and the header's *Games ↗* link; the bubble
   offers Report only.
10. **Layout:** z-index 9990, below the consent bar (9999) and the banners (9998); the bubble rides above the consent bar by
    its measured height (`--gcb-lift`, MutationObserver on `body`); a 76 / 68 px spacer at the end of the body lets the
    page's last lines scroll clear of the closed button; ≤ 600 px, open = a full-screen sheet with the page scroll locked.
11. **Esc** closes when focus is inside the panel (a non-modal dialog); opening moves focus to the panel title, so Esc
    works at once; closing returns focus to the button.
12. **nginx — no change, the estimate:** the `/play/api/` zone is 600 r/m per IP, burst 40. Per tab the bubble asks 15 r/m
    open + signed in, 4 r/m open + signed out, 1 r/m closed + signed in, 0 closed + signed out or hidden — the /play/
    panel's own budget. One IP reaches 600 r/m only with ~40 signed-in tabs open at once (or 40 people behind one NAT, each
    with the bubble open and signed in); the hidden-tab pause removes background tabs from that count. Server cost: a
    chat read is an id range on an index plus the in-memory change log — the same request /play/ already serves at that
    rate. Revisit only if C9 shows 429s on `/play/api/chat`.
13. **The probe's own lessons** (for R2): the games service refuses a loopback `X-Real-IP` (`client_ip`, by design), one IP
    gets about ten guest sign-ins before the login limit answers 429, a guest may post once per 15 s, and a body containing
    `window.top…` is held as link-like — a probe must vary the IP and the guest, and pick its fixtures with care.
14. **#22 can now be judged complete:** with D22-4 closed, no operator-authored markup reaches the origin as live DOM. R2
    confirms.

*Self-review against #30:* `textContent` only — the bubble builds every node with `createElement`, the rows come from the
core, `test-shell.js` [1] fails on any HTML sink in either file and [6] renders a `<img onerror>` body as a text node; no
session token anywhere (the cookie is `HttpOnly`, the hint is `'1'`); no full address: a miner shows as `address_masked`, a
guest's sign-in name only to its owner (from its own `/me`), and the typed address is cleared on success; no polling while
closed and signed out (measured: 0 requests over 10 fake-clock minutes in the vm, and over 20 s twice in Edge); nothing on exempt pages (the loader and
the bubble both check; Edge: `/play/` and `login.html` carry none); the preview flag honoured (loader test + Edge). The
accepted GA4 residue stands as written in #30.

*Verified:* games `npm test` **1316 → 1356**, 0 failed (`test-shell.js` 154 → 191: [6] the bubble's static rules + the
polling budget measured in a vm with a fake clock — closed + signed out 0 requests in 10 min, closed + signed in /me once
then one read a minute, hidden paused, open 15 / 4 s, a stale hint one 401 then silence, the unread dot; `test-launch.js`
50 → 53, `rules.mode`). Pool `npm test` **2797 → 2829**, 0 failed (`test-operator-code-sinks.js` 92 → 124: the three new
creators listed with guards, the one `srcdoc`, the sandbox token by token, the D22-4 call sites, the innerHTML ratchet down,
NEW [6] the loader in a DOM shim — 15 cases incl. storage that throws, a malformed stamp, maintenance, the login page).
**Headless-Edge probe 259/259** (session scratchpad only; the real games app in-process on an in-memory DB with a stubbed
pool link, a front server playing nginx with the page CSP and the `/play/` CSP read from the bash libs, 127.0.0.1; Edge
and both servers killed after, a process sweep found none left): home, account and a blog post × Reactor, Light, Galaxy ×
1280 / 390 px — the bubble shown with the stamp and no chat script fetched while closed; open, read (a markup body as text,
nothing ran); the anti-scam line; a 360 px panel / a full-screen sheet; a guest sign-in inside the bubble (password wiped,
hint set); a post shown as your own; Esc closes with focus back; closed: no horizontal overflow, no button in `<main>`
covered at a resting scroll, the footer scrolls clear, the button above a consent bar; on the post page the body in the
sandboxed frame with its `onerror`, `<script>` and page-wide `<style>` all contained, the frame sized to content with the
theme copied, an in-body `#anchor` scrolling the page; no new console error against a chat-off baseline of the same page.
Plus: chat off in the payload → no loader; a real-browser budget (0 requests in 20 s closed, a read every 15 s open, 0 again
after close); preview — a fresh browser gets no bubble, opening /play/ leaves the hint and the pool pages then show it;
`/play/` and `login.html` never carry it. **Not done:** nothing on a VPS; no real phone (the sheet with an on-screen
keyboard); the search-engine view of a framed post.

**R2 review — independent review of C5–C7 + whole-feature regression (2026-10-04, a cold session that built none of
it; code review + one-shot local probes on Windows, nothing run on a VPS).** Read: §19.17 in full, §19.13 #22–#30, the
§19.15 notes *Part C1*–*Part C7* and *R1 review*, and the working tree of `play/`, `public_html/`, `back-end-pool/` and
`07_lib_pool_games.sh` (everything since R1 is uncommitted, so "the diff since R1" is the working tree read against the
C5–C7 notes). Baseline before any edit: games `npm test` **1356**, pool **2829**, 0 failed — the C7 totals, reproduced.
*Observed during the review:* games `lib/app.js` and `lib/moderation.js` were re-saved at 20:18–20:19 by something other than
this session (three peer sessions share the repo), and `test-guests.js` held 153 checks when R2 first edited it, not
C5's 151. Both files were re-read afterwards and match the C2/C3/C5/C7 notes; every probe and suite run below ran
after that point, so they test the tree as it now stands.

*Threat notes.*
- **#26 — Guest auth: CONFIRMED after R2-1.** One wording, byte-identical for an unknown name and a wrong password, and
  no timing gap (medians 43.7 vs 43.6 ms over 20 pairs, each from a fresh IP — the dummy scrypt works); a drained unknown
  name answers exactly like a drained real one (429, same body); the ban only after the password. A stranger cannot lock
  the owner out: after 24 stranger failures from 24 /24s the owner from a /24 it signed in from still gets in (in any
  letter case). The scrypt cap holds under load — 160 concurrent logins from 160 IPs: sampled peak **4 in flight, 64
  queued**, the overflow `429 busy`, drained afterwards. **But the per-name failure budget did not hold under a
  PARALLEL burst — R2-1 below**, and neither did the per-account current-password lockout.
- **#27 — PoW: CONFIRMED** over HTTP against the real routes: replay → `used`; another /24 → `ip_changed`; the same /24
  from another host → accepted (bound to the /24 by design); > 5 min → `expired`; a token edited down to 14 bits →
  `invalid`; a raised `signup_pow_bits` reaches the next challenge. The sign-up limit: 3 from one /24, the 4th
  `signup_limit`, and a delete does **not** free a slot (the `guest_signups` log, C5 #2); the deleted login name is free
  at once from another /24.
- **#28 — Guest Sybil: CONFIRMED, residues recorded (R2-2).** Ten guests made from four /24s (≤ 3 each): fresh, none
  can post **or report** (reporting needs a chat-capable session, so the 24 h age gate covers it too); aged, their ten
  reports leave a miner's message **visible** (`countedReports` excludes `g:%`, and it is the only reader of
  `chat_report_threshold`); flat out for an hour they posted **100** messages — 10 each, the per-account cap — and a
  link-like body is held with `chat_hold_links` off. Elo and boards: `pair_rated_daily` per address pair, each guest
  bounded by 5 tickets a day (§19.8, `matches.js` `pairRated`); `mining_*` events filter `g:%`; boards and events skip a
  deleted player.
- **#29 — Identity fences: CONFIRMED.** The ONLY call that sends an id to the pool is `pool-link.verifyProof`, which
  refuses anything but a pool address of this network before connecting; `activity()` drops every inbound row that is
  not one; `plays.js` skips a `g:` row; `active_days` / `mining_minutes` bind `g:%` out; moderator appointment refuses
  `isGuestId`, the moderator routes are miner-only, and no `g:` id was ever in `moderators`. Crawl: a guest who renamed
  away from its sign-in name (`SecretLogin` → `VisibleNick`), with a bot game, an open seek and a chat post, was looked
  for in every public GET (chat, lobby, two boards, events, games, rules, turns, both matches) as an anonymous viewer AND
  as another player — no `g:` id, no id fragment, no login name anywhere; chat shows `VisibleNick · guest`; `/me` gives
  the login name to its owner only; a moderator's queue carries no guest id. Money-adjacent code does not exist in the
  games service.
- **#30 — Bubble: CONFIRMED** (a real browser, below): `createElement`/`textContent` only (`chat-bubble.js`,
  `play-chat-core.js`; the only script creator is the dependency loader with two fixed names); an operator chat body
  holding `<img onerror>` rendered as text and nothing ran; after a guest sign-in inside the bubble no input holds a
  value, neither the password nor the guest id is anywhere in the DOM, the cookie is not visible to script, the hint
  is `'1'`. The header shows the viewer's own sign-in name — R2-2 (d). The GA4 residue stands as written.
- **#22 — Option B: now COMPLETE.** With D22-4 closed, every script/frame/HTML sink in `public_html` and `play/shell` was
  re-listed: the provider loaders and the JSON-LD block (R1), the ads loader (`public-shell.js`, a fixed path), the
  bubble loader (two fixed paths, a 12-hex stamp), the bubble's dependency loader (two fixed names), the games frame
  host, and the ONE `srcdoc` (`cms-frame.js`). The innerHTML left in `post.html` carries only `esc()`-ed values (cover
  URL, tags) and `page.html` a constant. **The sandbox was attacked in headless Edge (Chromium):** a CMS body with a
  `javascript:` link (inheriting `<base target=_top>`, and with `_top` / `_parent` / `_self` / `_blank`), a
  `javascript:` `<area>`, an SVG `<a>`, a form with a `javascript:` action, a `javascript:` meta refresh and a `data:`
  link to `_top` was clicked with a real (CDP) mouse event — **none ran** (0 page exceptions). Two controls make that
  meaningful: a plain link in the same body DID navigate the tab (clicks reach the frame with user activation), and
  the SAME `javascript:` link in a frame that allows scripts DID run in the page — the page CSP (`'unsafe-inline'`) does
  not stop it, the missing `allow-scripts` does. *Not tested:* Firefox and Safari.

*Mandatory probes.* (1)–(4) are #26–#29 above (scratchpad harness against the real games app in-process on 127.0.0.1,
stubbed pool link; **34/34**, closed in the session). (5) **Bubble** — headless Edge against a loopback front server
playing nginx (the pool page CSP and the `/play/` CSP), the real games app in-process, the pool's real `index.html`,
`login.html` and the real `/play/` shell, Edge killed and its profile deleted after: the loader inserted the stamped
bubble; **requests per minute measured in the browser: closed + signed out 0 (65 s, and no chat dependency fetched),
open + signed out 4, open + signed in 15, closed + signed in 1 (2 in 125 s), hidden 0 (125 s)** — §19.17.7's budget and
C7 #12's estimate; `login.html` and `/play/` carry no bubble; preview without the hint → none, with it → shown; chat off
in the payload → none. **17/17 + the frame section 3/3.** *(Hidden was driven by redefining `visibilityState` and
firing the event — headless Edge has no background tab; the vm harness in `test-shell.js` [6] does the same.)* (6)
**Money untouched: CONFIRMED.** No file in the money path changed — `wallet.js`, `wallet-tor.js`,
`withdrawal-scheduler.js`, `owner-proof.js`, `rewards.js`, `reconciliation.js`, `donor-ledger.js`, `nostr-payout.js`,
`ledger-rollup.js`, `shares.js`, `block-monitor.js`, `auth*.js` have no diff, and neither do the treasury/payout admin
pages. Every hunk of `index.js` was mapped to its route: C1 (an ad comment), C4 (the donor-name route, its refusal
table, the admin donor-name routes and the C4 start-up migration), C2 (the branding/settings readers) and §20 (node
availability — the `/api/pool/status` `up_days` field and two `secureAdmin` reads). The other changed back-end files
are C4 (`donor-names`, `donor-profiles`, `db.js` `banned_donor_names`, `pool-settings`) and §20 observers
(`grin-node.js` adds an `auth` transport class read only by the display-only `downState()`; `node-stratum-client.js`
calls an observer inside `try/catch`; `alert-monitor.js` reuses a fresh probe; `retention.js` prunes `node_events`) —
none reaches a balance, a payout or a proof. No games or guest session reaches any pool route (the cookie is
`Path=/play/`). (7) Suites below.

*Departures judged.* **C5:** all seventeen accepted — #1 own login route (nginx's `^~ /play/api/login` prefix covers
`/login/guest` and not `/logout`); #2 the unlinked `guest_signups` log (verified: a delete frees no slot); #3 the
copy-back rebuild; #4 the live age gate; #5 the PoW spent before the limits (its cost is R2-2 (b)); #6–#9; #10 `g.<16>`
admin paths (re-read in `moderation.js` `playerParamOf`: a guest id that names no guest is 404); #11 `Guest-XXXX` from a
hash; #12–#17. **C6:** all fourteen accepted. On #1 (plain-JS PoW, not WebCrypto): accepted — the solver touches no
secret and the server verifies with Node's SHA-256, so a solver bug can only fail a sign-up. But record what 18 bits
buys: ~0.5 s in a browser is ~0.02–0.05 s to native code, so **the PoW is a speed bump, not the Sybil control — the
per-/24 limit is**; C9 should weigh 20 bits (4×) after timing a phone. **C7:** all fourteen accepted — #1 the sandbox
(verified above); #2 the loader in `branding.js` (it runs after the maintenance return and checks `isCredentialPage()`
itself); #4 lazy dependencies (verified: none fetched while closed and signed out); #5 the duplicated row CSS and
sign-in sentences; #8 sign-out in the bubble; #12 no nginx change (the measured 15 r/m per open signed-in tab against a
600 r/m zone).

*Findings (audit roll-up rows R2-1, R2-2).*
1. **R2-1 (Medium) — the guest per-name failure budget, and the per-account current-password lockout, could be raced.
   FIXED.** `guests.js` login PEEKED the budget before the scrypt await and TOOK a token only after a failure — the
   miner login's shape, which is harmless there because the pool's own throttle sits behind it; a guest login has no
   pool behind it, so this budget IS the brute-force stop. Every request of a parallel burst passed on the same token:
   **60 of 60 concurrent wrong guesses from 60 /24s were evaluated against a budget of 20, and again 60 of 60 each time
   one token refilled (180 s)** — up to ~68 (the scrypt queue) per refill, ~1,360 an hour instead of 20. The per-IP
   limits did not help (one request per IP). `checkCurrent` (password change, delete) had the same shape: 8 parallel
   wrong current passwords on one account → 8 evaluated. Fix: the login TAKES the token before the await as a
   reservation and gives it back (`refund`, new on `createTokenBuckets` in `ratelimit.js`) unless the attempt ends as a
   wrong password — so it still counts failures only, a success or a `busy` costs nothing, and the known-/24 owner path
   is unchanged; `checkCurrent` is single-flight per account (only a holder of that account's session reaches it, so a
   stranger cannot use it to block the owner). Accepted side effect: more than 20 SIMULTANEOUS attempts on one name wait
   while their scrypts run, right password or not; they are back the moment those finish. After: 20 of 60, then 1;
   8 parallel → 1. `ratelimit.js`'s header (which called the pool's throttles the real stop) now says so for guests.
   `test-guests.js` +4 (40 parallel → exactly 20; one refill → exactly 1; successes leave the full budget; 8 parallel
   current-password guesses → 1), mutation-checked: the old code fails 3 of them.
2. **R2-2 (Info) — residues, recorded as accepted.** (a) While a stranger keeps a name's budget drained (one failure per
   3 min, from any IPs), its owner on a /24 it has never signed in from waits — a travelling or carrier-NAT owner; and a
   stranger INSIDE the owner's /24 skips the per-name budget (the per-IP locks still apply). Part 4 #3's trade-off,
   unchanged. (b) The PoW used set (50 000) fails closed, so ~2,500 IPs each spending their 20 challenges an hour inside
   5 minutes would turn sign-up `busy` for everyone; existing guests are unaffected and the operator has
   `guest_signup_enabled`. (c) Aged guests can fill the moderation queue with reports (20 an hour each) — noise, never a
   hold — and can farm PvP points/Elo within `pair_rated_daily` and 5 tickets a day (D1: points are worthless). (d) The
   bubble's header says "as <sign-in name> · guest" on EVERY public page (C6 #6 did the same on /play/), so a screenshot
   of any pool page shows the sign-in name even after a nickname change; it is the viewer's own and §19.17.3 rests the
   security on the password and the limiter, not on the name's secrecy. Showing the live nickname there instead would
   be a one-line change if the operator prefers it.

*Verified:* games `npm test` **1356 → 1362**, 0 failed (`test-guests.js` 153 → 157 — the four R2-1 checks; the two
checks above C5's 151 predate this session's edits, see *Observed*); pool **2829 → 2829**, 0 failed (no pool code
changed); `bash -n scripts/lib/07_lib_pool_games.sh` clean (the C5 sign-up location: the same proxy headers and 4 KB cap
as the login location, its own 6 r/m zone). Every probe process ended in the session (a final sweep found none). **Not
done:** nothing on a VPS; Firefox/Safari against the CMS sandbox; a real phone (C9).

### 19.16 Approved nicknames (Part 12, built 2026-09-28, NOT VPS-tested)

> **Superseded for pre-moderation by §19.17 (D27, 2026-10-03).** Names are now checked automatically
> and live at once; the queue, the `pending` state and the 2–20 / space-and-punctuation rule below are
> replaced by §19.17.5 since Part C3 (2026-10-04, §19.15 *Part C3*). Kept as the history of what Part 12 built — the `names.label`
> rule ("a nickname is never shown alone", for miners) and the request-log table carry over unchanged.

D19 made the masked address the only name in v1 and left nicknames as an optional Part 12; the operator
chose them on 2026-09-28. This is the contract as built; the departures from the plan's prompt are
§19.15 *Part 12*.

**The rule that matters: a nickname is never shown alone.** Every public name comes from one server
function, `names.label(address)`, which returns the mask (`grin1abcd…wxyz`) or `Nick (grin1abcd…wxyz)`.
Chat, the boards, event standings, the lobby, match seat labels and a challenge's target all call it, into
the same `name` field they always had. A mask costs ~2^40 key generations to grind (§19.13 #10); a nickname
costs nothing to copy — so the nickname adds a readable handle and the mask stays the identity. The
**Operator** and **Mod** badges remain the only trusted markers.

**Pre-moderated.** Nothing a player types is shown to anyone else until the operator approves it. The
pending text is shown back to its author on `/me` (session-bound) and in the admin queue, nowhere else.

**The name rule** (the pool's §18.5 donor-name rule, copied — D5 — with the changes in §19.15 *Part 12* #2):
trim and collapse ASCII whitespace; 2–20 characters of `A–Z a–z 0–9 space - _ & '`; at least one letter;
refused outright when it looks like an address (`grin1` / `tgrin1`, separators ignored) or contains
`operator`, `admin` or `moderator` in its matching form. The **matching form** is lower-case, separators
removed, the leet digits `0 1 3 4 5 7` folded to `o i e a s t` (`0per4tor` → `operator`, `B-o-b` → `bob`).

**Who may ask:** a signed-in player passing the chat gate minus the pool's chat switch
(`auth.chatStatus(s, { ignoreChatSwitch: true })`: an aged, non-anchor proof, recent mining, not muted, and
the password rule when it is on), while the games-owned setting `nicknames_enabled` (default on) is on.
5 requests per address per 24 h.

**Lifecycle** (per address; one row per request, `nicknames`, §19.4 v3):

| From | Action | To |
|---|---|---|
| — | player submits | `pending` (a previous pending → `replaced`) |
| `pending` | player withdraws | `withdrawn` |
| `pending` | operator approves | `approved` (the previous live one → `replaced`) — refused `nickname_taken` when another address's live name has the same matching form |
| `pending` | operator rejects `{reason?}` | `rejected` — the reason is shown to the player |
| `approved` | player removes · operator removes `{reason?}` | `removed` |
| `approved` / `pending` | the address is banned | `removed` / `rejected` (reason `ban`); an unban restores nothing |

One pending and one live per address, and no two live names with the same matching form, are partial
unique indexes. Decided rows are purged after 180 days (hourly job `nickname_purge`).

**Routes.**

| Route | Does |
|---|---|
| `POST /play/api/nickname {name}` | submit (400 `name_*` with a `hint`; 403 `nickname_refused` + `reason`/`available_at`; 403 `nicknames_off`; 409 `unchanged` / `nickname_taken`; 429) |
| `POST /play/api/nickname/withdraw {}` · `POST /play/api/nickname/remove {}` | the player's own pending / live one |
| `GET /play/api/me` → `nickname` | `{ enabled, live, shown_as, pending:{name,at}\|null, refused:{name,state,reason,at}\|null, can_submit, reason, available_at, rule }` |
| `GET /internal/admin/nicknames?state=pending\|approved\|rejected` | the queue (oldest first) or the lists (newest first), full addresses, `shown_as`, and on pending rows the **flags** |
| `POST /internal/admin/nicknames/:id/{approve,reject,remove}` | step-up (not in `FAST_WRITES`); each writes a `mod_actions` row |

**Flags** on a queued name — hints beside it, never decisions: `reserved` (pool, grinium, official,
support, staff, prize, jackpot, winner, mod, bot — the pool's reserved words plus this page's own two
labels), `word` (a chat word-list entry), `same_as` (another address's live name matches; approve is
refused), `pending_same` (another request matches).

**Admin:** Games → **Nicknames** (`games-names.html`: the queue, Live, Rejected; approve / reject / remove,
all step-up; every name and reason rendered as text). The Players page shows an address's live and
pending nickname; `games.html` carries the `nicknames_enabled` switch.

### 19.17 Open community (v2) — site-wide chat, guest accounts, auto-checked names (DESIGN 2026-10-03, Part C0; C1–C4 built 2026-10-04 — §19.15 *Part C1*, *Part C2*, *Part C3*, *Part C4*; R1 reviewed them the same day — §19.15 *R1 review*; C5 built 2026-10-04 — §19.15 *Part C5*; C6 built 2026-10-04 — §19.15 *Part C6*; C7 built 2026-10-04 — §19.15 *Part C7*; R2 reviewed C5–C7 the same day — §19.15 *R2 review*)

The operator discussion of 2026-09-28 → 2026-10-03 reopened four things the v1 contract had fixed: where
chat lives (only inside /play/), who may play (miners only), how names are approved (pre-moderated) and
whether the games ship off. This section is the **contract** for that work. It is broken into eleven
sessions — C0 (this text), C1–C7 builds, two independent reviews R1 (after C4) and R2 (after C7), and C9,
the mainnet acceptance run, which **replaces** §19.14's Part 13 so the box is tested once, against the final
code. (There is no C8: that number was the first review slot, and naming the reviews R1/R2 keeps a review
from being mistaken for a build.) The per-session plan is kept outside the repo, as for §16–§19. When a
build finds this section wrong, it records the change in §19.15 and does not diverge silently.

**Operator answers taken in C0 (2026-10-03):**
1. The header group that holds Fortune Board, Contribute and now Play is named **"Community"** (D31).
2. Donor names **keep their current character set** — `A–Z a–z 0–9 space - _ . & '`, 2–32 characters —
   rather than narrowing to the nickname rule's letters + digits (D29, §19.17.6).
3. The visible word on /play/ becomes **"tickets"**; every internal name (`plays` columns, `plays_*` settings,
   the `no_plays` code, routes) stays as it is (D25, §19.17.4).

**One finding C0 made while writing this, which shapes §19.17.5:** the pool's donor flag-word list is
matched as a **substring** of the matching form, and its own comment accepts the false positives
(`classic` ⊃ `ass`) because "a hit only highlights a queued name, the admin decides". Once names go live
on an automatic verdict, that same matching would refuse *Classic*, *Bassist* and *Cassandra* with "this
name isn't allowed". So the Scunthorpe rule in §19.17.5 covers the **blocked-word list too**, not only the
reserved words the plan named.

#### 19.17.1 Decisions D22–D32 (operator, 2026-09-28 → 2026-10-03)

| # | Decision | Why |
|---|---|---|
| D22 | **Option B — no operator-authored code runs on the pool origin.** Delete the ad type `code` end to end (the renderer in `ads.js`, ad create/update acceptance, the admin form option) and both analytics sinks `analytics.custom_head_html` / `custom_body_html` (the render path in `branding.js` `applyAnalytics` and its `cloneScript`, the settings keys, the branding payload, the admin fields). Analytics stays as **provider-ID loaders only** — GA4, Plausible, Umami — each building its `<script>` from an ID matched by a strict pattern, never from free text. The operator uses GA4 and plans no ad-network code. Image and link ads stay. A stored legacy value (a code ad, saved custom HTML) is ignored, never sent to a browser, and the admin UI says why. **Closes open question O1** (§19.15 *Part 11 review*; audit roll-up P11-4) by removing the sinks rather than opting single pages out of them. | **One origin is one trust zone.** D23 puts a sign-in form on every public page; a script on any page of the origin can read a password typed on any other page of it — `/play/` included, through a same-origin window or iframe — and can ride a session cookie by making requests as the page. O1's fix (exempt the account page) protected one form; with sign-in everywhere there is no page left to exempt. Filtering `<script>` out of the HTML is not a fix: `<img onerror=…>`, `<svg onload=…>` and a dozen other attributes run code, so a sanitiser would be a second thing to get right forever. The sinks go instead. **Residual, accepted (§19.13 #30):** the provider loaders are third-party scripts on the origin too; the operator trusts GA4. |
| D23 | **Floating chat on every page that loads `public-shell.js`**, except pages marked `data-untrusted-html="exempt"` (the pool's `login.html`; `/play/` keeps its own G-07 panel). From the bubble a visitor can **read** chat (anonymous), **sign in** — a miner with address + proof, a guest with name + password — and post. **Sign-up happens only on /play/**, because it needs the proof-of-work (D24). The bubble script is **owned by the games tree** (`/play/js/chat-bubble.js` + its CSS, deployed and stamped with the shell); the pool carries only a tiny loader that inserts it when the branding payload says chat is on in the effective mode (§19.17.7). | One sign-in, available everywhere, without the pool docroot carrying games code. If games is not installed or not healthy the payload says off, so the loader inserts nothing — no games deploy, no bubble — and there is one chat client codebase (the panel and the bubble share a core, C7), not two. |
| D24 | **Guest accounts: name + password, NO email.** Sign-up costs a proof-of-work (a few seconds of browser CPU; a stateless HMAC challenge, single-use), **at most 3 sign-ups per IP per 24 h**, a name passing the nickname rule (D27), and a password of ≥ 10 characters, stored scrypt-hashed. The identity key is **`g:<random>`**, stored in the existing `address` columns, so every games table works unchanged and the pool is **never** called for a guest. The **login name is permanent and is never displayed by the server as a login name** (it starts as the guest's public nickname — see §19.17.3 for what "private" can and cannot mean); the public nickname is separate and may be changed or removed. A guest can change their password and **delete their account**. Idle guest accounts are deleted after `guest_idle_days` (default 180), so names are not squatted forever. | The operator's words: open the games to **non-miners**, without mail infrastructure or personal data. Email would add a mail server (or a third-party sender), a store of personal data and a recovery flow, and buys little: throwaway inboxes defeat it as a Sybil control. Points are worthless (D1), so a lost guest account is a small loss and needs **no recovery path** — "make a new one". A separate login name means removing an offensive nickname never locks its owner out of their account. |
| D25 | **Tickets** (the visible word; internally still `plays`). **Guests: 5 per UTC day**, reset to `guest_daily_plays` at 00:00 UTC — topped back to 5, **never saved up**. **Miners: unchanged (D10)** — 1 per 10 active minutes, ≤ 24 a day — and **banked up to 999** (`plays_balance_cap` default 100 → 999). Hashrate never changes the number. Operator, 2026-10-03: the visible word on /play/ becomes "tickets"; internal names do not change. | The miner benefit is about 5× the games a day plus the right to save them; a farm still cannot buy the boards (D10). The operator found "plays" unclear and used "tickets" themselves; renaming only the visible word keeps every key, column and code stable. |
| D26 | **Guest chat** is allowed once the guest account is ≥ `guest_chat_min_age` old (default 24 h, with the same 1 h floor constant as D9), behind its own switch `chat_guests_enabled` (default on). Guests have stricter rates (1 per 15 s, 10 per hour); a link-like body from a guest is **always** held, whatever `chat_hold_links` says; and **reports by guests never count toward the auto-hold threshold** (they still reach the moderation queue). | Guest accounts are cheap — three sign-ups from one IP a day, more across IPs. Three of them must not be able to hide anyone's message, and the age gate makes a flood need a day's preparation per account. |
| D27 | **Nicknames are auto-checked and live at once** — no pre-moderation (replaces §19.16's queue). **Rule:** 3–20 characters, **`A–Z a–z 0–9` only** — no space, no punctuation, no accents (the operator's explicit choice). Case is kept for display; uniqueness and every word check run on the **matching form** (§19.17.5). **Refused:** reserved words, the pool-owned blocked-word list (D28), the games chat word list, anything address-like (`grin1…` / `tgrin1…`), a **banned name**, a name whose matching form equals a live one. A word-list or reserved hit answers only *"this name isn't allowed"* — no list probing. **One change per `nickname_change_days`** (default 7). Miners still need the aged-proof chat gate to set one. **Admin:** list + search, remove, **ban name** (that matching form can never be taken again), **block player** from nicknames. **Moderators may remove** a nickname — not ban, not block, and never an operator's or another moderator's. **Display:** miners unchanged, `Nick (grin1abcd…wxyz)`; guests `Nick · guest`, or `Guest-XXXX` (derived from the id) with no nickname. | The operator does not want a queue to work through. The reserved words and the list catch most abuse at the door; post-moderation by the operator *and* the moderators catches the rest, and a ban makes a removal stick. ASCII letters + digits kill look-alike letters, RTL tricks and the `free-grin.io`-as-a-name case at once. The aged-proof gate stays for miners because a stranger who mined a few shares to your address must not be able to name you. |
| D28 | **ONE blocked-word list, owned by the POOL** (`names.blocked_words`: an admin textarea, one entry per line, added on top of a seed list in code). It is used by game nicknames and guest sign-up names (sent through the existing `/internal/games/config` route; the games service caches it **and persists the last good copy**, so a pool outage keeps the last list and the seed always applies) and by **donor names**. The games **chat** word list stays games-owned, with chat's HOLD semantics, and is ALSO applied to nicknames (as Part 12's `word` flag already did). The pool's `donor_name_blocklist` setting is retired into it (C4). | The pool is the always-on half of the pair, and donor names live in the pool, so the list must live there too. D5 holds: games receives data over the link and never reads pool code or `pool.db`. |
| D29 | **Donor NAMES: the same auto-check, live at once**, with admin remove / ban name / block donor. The character set and length stay as §18.5 (operator's C0 answer). **Donor BANNERS stay pre-moderated** — the operator will revisit banners as a separate topic; nothing in this plan touches the banner path. | A word list can check text; it can never check an image. |
| D30 | **Default ON, first install in PREVIEW.** Pool defaults become `games.mode = 'on'`, `games.chat_enabled = true`. The games DB carries a **launch state** (`meta.launch`; `preview` on a fresh DB, and an absent key reads as `preview`). **The effective mode is the lower of the pool's mode and the launch state** (off < preview < on), applied by every public games route AND reported through the probe so the branding payload, the nav and the bubble follow it. Admin Games → Overview gets **Go live** / **Back to preview** (step-up). No bash writes pool settings. | A safe default for new pools: installing the service never announces it before the operator has done one test run, yet nobody has to find a hidden switch to turn it on. On the live pool the same rule means that deploying games is not a launch. |
| D31 | **Header:** Play moves INTO the dropdown that holds Fortune Board + Contribute, and that group is renamed **"Community"** (operator, C0). The group shows when **any** child is visible — incentives on → Fortune Board + Contribute; games effectively on → Play — and each child keeps its own gate. The footer follows. | Play belongs beside the other "extras". A group whose children are all hidden must disappear, not render as an empty dropdown; a group hidden by one child's flag would hide the other's links. |
| D32 | **Money is unchanged.** Every money action keeps its per-request proof; no games or guest session ever authorises a money route; the Nostr/Goblin destination gate keeps AND+AGE. Moderators stay **miner addresses** (D21) — a guest can never be appointed. | Restated so that no later part "simplifies" it. A session that could withdraw would turn one weak proof — anyone can mine a share to your address — into a 14-day bearer token, and the games service is barred from money by D5 anyway. |

**Amended in place on 2026-10-03 by this section:** D8 (two login kinds), D9 (guest chat age), D10 (balance
cap 999), D12 (default on + launch state), D19 (auto-checked names), D21 (moderators may remove nicknames;
guests are never moderators); §19.16 is now history for the pre-moderation flow. **Still open, carried:**
O2, the moderator-inheritance limit (§19.15 *Part 11 review*) — C9 asks.

#### 19.17.2 Launch state and the effective mode (D30)

Two switches, owned by two services, combined by one rule: **effective = min(pool mode, launch)**, with
`off < preview < on`.

| Pool `games.mode` ↓ · launch → | `preview` | `on` |
|---|---|---|
| `off` | **off** | **off** |
| `preview` | **preview** | **preview** |
| `on` | **preview** | **on** |

Two failure rows sit on top of the table, unchanged from §19.2: the **games** side treats a pool it has not
reached for > 10 min as `off`; the **pool** side reports `off` while its probe is unhealthy. So "a pool
that cannot reach games reports off" still holds (§19.13 #23).

- **Where launch lives:** `meta.launch` in `grinium-games.db`, values `preview` | `on`. A fresh DB writes
  `preview`; an absent key on an upgraded DB reads as `preview`. It travels with the DB, so a restored
  backup keeps its launch state. There is no `off` launch value — `off` is the pool's switch.
- **Games side:** `mode.js` computes the effective mode from the cached pool mode and `meta.launch`, and
  `publicRoute()` gates every public route on it, exactly as it gates on the pool mode today (Part 4 #1:
  `off` 404s login too). Admin routes stay outside `publicRoute()` and work in every state.
- **Pool side:** the probe already reads `/play/api/health` every 60 s. Health gains **`launch`**, and the
  pool computes the effective mode itself for the branding payload (`games: { mode: <effective>, chat }`,
  `chat` false whenever the effective mode is `off`). **No second probe.** A health flip already calls
  `invalidateBranding`; a launch flip must too. *Disclosure, accepted:* health is public through nginx, so
  `launch: preview` tells a visitor the games exist — which /play/ itself already tells anyone who
  types the URL in preview.
- **Admin:** `POST /internal/admin/launch { state: 'preview'|'on' }`. It is not one of the six
  `FAST_WRITES`, so it is step-up by the fail-closed rule (§19.11) — no pool code change for that. It
  writes one `mod_actions` row (`launch`, old → new) and is idempotent (same state = 200, no row).
  `games.html` Overview shows the effective mode, both inputs, and **Go live** / **Back to preview**.
- **Defaults (pool):** `games.mode` `'on'`, `games.chat_enabled` `true`. A **saved** Settings → Games row
  overrides the default — the live pool may already have saved `off`, and C9 checks it.

#### 19.17.3 Guest accounts (D24, D26, D32)

**What "private login name" can mean.** The sign-up name becomes both the login name and the first public
nickname, so on day one the login name is on every board the guest appears on — exactly like most
username systems. What the server guarantees: it **never** discloses a login name *as* a login name; `/me`
returns it to its owner only; after a nickname change nothing public is derived from it; and the
**only** place the login namespace can be probed is sign-up, which costs a PoW and the per-IP limit. So a
nickname is checked for uniqueness against **live nicknames and banned names only**, and a sign-up name
against live nicknames, banned names **and all login names** — otherwise *"nickname taken"* on the cheap
rename path would answer "someone logs in with that name". The password, the per-name limiter and the
uniform wording carry the security, not secrecy of the name.

**Routes** (all behind `publicRoute()` — effective mode ≠ `off`, CSRF layer 3; preview is allowed, so
acceptance can sign up):

| Route | Does |
|---|---|
| `GET /play/api/signup/challenge` | a PoW challenge (below); per-IP bucket |
| `POST /play/api/signup { name, password, challenge, nonce }` | creates the guest + player + live nickname + a session; sets the cookie exactly as §19.5 |
| guest login | `{ kind:'guest', name, password }` — either on `/play/api/login` or its own route; C5 picks the one that keeps `login.js`'s strict body schema simple, and records why |
| `POST /play/api/account/password { current, next }` | changes the password; revokes every OTHER session of the guest |
| `POST /play/api/account/delete { password, confirm }` | deletes the account (below) |

**Proof-of-work.** Stateless: the challenge is `v1.<ip_coarse>.<exp>.<bits>.<rand>.<hmac>`, where
`ip_coarse` is the caller's /24 (IPv4) or /48 (IPv6), `exp` = now + 5 min, `bits` the current difficulty,
`rand` 16 random bytes, and the HMAC (SHA-256) keyed by a random per-process key — a restart only
invalidates open challenges. The client finds a `nonce` such that `sha256(challenge + ':' + nonce)` has
`bits` leading zero bits. The server verifies with one HMAC + one SHA-256, then checks: not expired; the
caller's `ip_coarse` equals the token's; and the token is not in the **used set** (in memory, keyed by the
token's hash, pruned at expiry — single-use; a restart empties it, which is safe because the key changed
too). Difficulty is the setting `signup_pow_bits` (default **18**, range 14–26; 14 is a module-constant
floor a setting may raise but never remove — the D9 pattern). 18 bits is ~260 k hashes on average: C6
measures the real time with chunked WebCrypto and C9 times it on a phone; the default moves if either is
far from "a few seconds". *(C6 measured: WebCrypto ~37 k hashes/s in Edge — 7 s on average, 25 s once — so the client
is plain JavaScript over a midstate, ~570 k/s, sign-up ≈ 0.5 s at 18 bits on a desktop; §19.15 *Part C6* #1. The phone
timing is still C9's.)*

**Sign-up, in this order** (copying §19.5's shape — every cheap refusal before any expensive step):
1. mode gate (`publicRoute`) → `guest_signup_enabled` (games setting, default on — **added by C0**: an
   operator under a sign-up flood needs a switch smaller than the whole games mode; existing guests keep
   signing in while it is off);
2. body caps (JSON ≤ 4 KB, exact keys, string lengths);
3. PoW verify (above);
4. a per-IP **attempt** bucket (in memory, tighter than nginx's zone) → the per-IP **success** limit,
   `guest_signups_per_ip` per 24 h (default **3**, range 1–10), **counted from the `guests` table** by
   `created_ip_coarse`, so a restart does not reset it;
5. the name rule (§19.17.5), unique against live nicknames, banned names and all login names;
6. the password rule: 10–128 characters, not equal to the name's matching form, not on a small common
   list; no composition rules;
7. the **global scrypt cap** — ≤ 4 scrypts in flight across sign-up, guest login, password change and
   delete, ≤ 64 waiting, beyond that 429 `busy` (16 MB each keeps the worst case at 64 MB under the
   unit's `MemoryMax=384M`);
8. scrypt (the pool's `v1$salt$hash` format and parameters, **copied** — D5);
9. one transaction: `guests` row + `players` row (`kind 'guest'`) + the live nickname + a session
   (`proof_kind 'guest'`, `chat_ok_after = created_at + max(CHAT_MIN_AGE_FLOOR, guest_chat_min_age)`).

**Guest login.** Limits copy Part 4 #3, keyed on the login name: a per-IP bucket; per-IP and per-(name, IP)
**failure** lockouts; a per-name **failure** budget that an IP whose /24 (/48) had a session for that guest
in the last 30 days skips — so a stranger cannot arm a permanent lockout. An unknown name runs a **dummy
scrypt** (no timing oracle), and an unknown name and a wrong password get **one** wording (`login_failed`).
The ban check runs **after** the password check for guests (the reverse of §19.5 step 3): a ban answer
before it would tell anyone "this name exists". Sessions are §19.5's, 20 per account, 14 days hard.

**Delete** (by the guest, by an admin — step-up — or by the idle job): in one transaction, the `guests` row
is deleted (the login name is **free at once** — labels are keyed by id, not name), every session revoked,
the live nickname `removed` (reason `account_deleted`), and the `players` row **kept** and marked deleted,
so match history, ledger rows and event results still resolve and `names.label` shows **"deleted guest"**.
Deleted accounts are skipped by the boards. **Idle job** (hourly): a guest with no login for
`guest_idle_days` (default 180, range 30–3650) and no live session is deleted the same way.
`created_ip_coarse` is needed only for the 24 h sign-up count, so the hourly job NULLs it after 7 days.

**Chat for guests (D26)**, inside `auth.chatStatus`: the switch `chat_guests_enabled`; the account-age gate
via `chat_ok_after` (it **replaces** the recent-mining gate, which a guest can never pass); a guest session
counts as a password session for `chat_requires_password`; rates 1 per 15 s and 10 per hour per account,
on top of the existing per-IP 60/h; a link-like body is always held; reports by guests reach the queue but
are not counted toward `chat_report_threshold`.

**Identity fences (D32; §19.13 #29).** `g:` + 16 base32 characters (80 bits). `GRIN_ADDR_RE` never matches
it, and the code adds explicit guards rather than relying on that: `pool-link` refuses to send a `g:` id
(assert + test); the activity sync credits only pool addresses; moderator appointment refuses `g:`;
`mining_*` event kinds skip guests; nothing money-adjacent exists in the games service to reach. `/me`
gains `kind`, and returns `login_name` to its owner only.

**Schema v5 — a sketch; the binding text lands in §19.4 in the same change as the migration (C5), because
§19.4 is test-bound (§19.15 *Part 1*):**

```sql
CREATE TABLE guests (
  id                TEXT PRIMARY KEY,            -- 'g:' + 16 base32
  login_name        TEXT NOT NULL,               -- as typed at sign-up; never displayed as a login name
  login_norm        TEXT NOT NULL UNIQUE,        -- matching form (§19.17.5)
  pass_hash         TEXT NOT NULL,               -- 'v1$salt$hash' (scrypt, the pool's format)
  created_at        INTEGER NOT NULL,
  created_ip_coarse TEXT,                        -- /24 or /48; NULLed after 7 d
  last_login_at     INTEGER NOT NULL
);
-- players gains kind ('miner'|'guest', default 'miner') + deleted_at (NULL = live) + the guest top-up day (§19.17.4)
-- sessions: proof_kind must accept 'guest'. SQLite cannot ALTER a CHECK, so this is a TABLE REBUILD
-- (create new → copy → drop → rename, one transaction); a test proves existing sessions survive it.
```

#### 19.17.4 Tickets (D25)

- **Miners:** §19.6 unchanged except `plays_balance_cap` default **999** (the range stays 1–10000).
- **Guests:** at the first spend or `/me` of a UTC day, the balance is **set** to `guest_daily_plays`
  (default 5, range 0–100): one ledger row `(plays, guest_daily − plays, 'guest_daily', 'gd:<day>')`, in
  the **same transaction** as the spend, or in its own for `/me`. The delta may be negative (an admin gave
  extra yesterday — "never saved up"), and no row is written when it is 0. Because a 0-delta day writes no
  ledger row, the ref cannot be the only marker: `players` carries the **day the top-up last ran**, set in
  the same transaction, and `gd:<day>` (via `uq_ledger_ref`) is the second guard. **`Σ ledger = plays`
  still holds** and `ledger.verify()` checks it. The activity sync never credits a guest.
- **Visible word:** "tickets" everywhere on /play/ and in the bubble — the placard, the folds (*"How tickets
  are earned"*, explaining miner vs guest with the LIVE settings), errors and buttons — with *"resets at
  00:00 UTC"* for guests. Admin pages keep the internal names (C6 may add "(tickets)" to a label).

#### 19.17.5 Names v2 — the rule, the list, admin and moderator actions (D27, D28)

**One rule, two copies.** D5 forbids sharing code, so the games service (`play/server/lib/name-rule.js`) and
the pool (`back-end-pool/lib/name-rule.js`) each carry a copy, both driven by **one fixture file**
(`play/server/scripts/fixtures/name-rule.json`: input → expected verdict and reason). The pool's test reads
that file by path; a drift between the copies fails a test (§19.13 #24).

**Shape.** Nicknames and guest sign-up names: 3–20 characters of `A–Z a–z 0–9`, nothing else. (Donor
names keep §18.5's shape — §19.17.6.)

**Matching form** — what every uniqueness, ban and word check compares: lower-case; separators removed
(only donor names can contain any); the leet digits `0 1 3 4 5 7` folded to `o i e a s t`. (`@` and `$`,
named in the plan, cannot occur under either character set.)

**Refusals, in order** (the first hit answers):
1. **shape** — `name_*` with a hint (the only refusal that explains itself);
2. **address-like** — the lower-cased name starts with `grin1` or `tgrin1` (before the leet fold);
3. **reserved words** — at least: `operator`, `moderator`, `admin`, `official`, `support`, `staff`,
   `grinium`, the live pool name (from the config route; accents stripped and any other character outside
   `a–z 0–9` dropped, so punctuation never un-reserves it — §19.15 *R1 review* R1-1), `mod`, `bot`, `pool`, plus the **prefix** rule
   `guest` (so no one can wear another guest's `Guest-XXXX` label) and `deleted`;
4. **blocked words** — the pool seed + the operator's `names.blocked_words` + the games chat word list;
5. **banned name** — the matching form is in `banned_names`;
6. **taken** — another live nickname has the same matching form (sign-up also: any login name).

Refusals 3–4 answer only *"this name isn't allowed"*; refusals 5 and 6 answer *"that name isn't
available"*. A banned name is told apart from a taken one only to the admin.

**The Scunthorpe rule (§19.13 #25), for reserved AND blocked words alike:**
- an entry of **≤ 4 characters** (`mod`, `bot`, `ass`, …) matches only the **whole** name — compared after
  stripping leading and trailing digit runs and then leet-folding (`Mod1` → `mod` → hit; `M0d` → `mod` →
  hit; `Modern`, `Bassist`, `Classic` → pass);
- an entry of **≥ 5 characters** matches as a **substring** of the matching form, except where the hit lies
  inside a word on a short code-owned **exceptions** list (`badminton` ⊃ `admin`, …);
- an operator entry may override its default: a leading `*` forces substring, a leading `=` forces
  whole-name (a 4-letter slur can be made substring; a 6-letter word can be made exact).

The fixture carries an **innocent list that must pass** (at least *Modern, Pooler, Abbott, Bottle, Classic,
Bassist, Cassandra, Badminton, Scunthorpe, Staffy*) and an adversarial list that must refuse (leet, mixed
case, digit padding, the pool name, address-likes). R1 adds 30 of its own.

**The list (D28).** `names.blocked_words` is a pool setting: an admin textarea, one entry per line, ≤ 500
entries × ≤ 32 characters, each normalised to the matching form (keeping a leading `*` / `=`), added on top
of a code seed (the current `STARTER_BLOCKLIST`), cached, and failing open to the seed — the pattern of
`access.extra_banned_passwords`. `/internal/games/config` gains `blocked_words` and `pool_name`. The games
service caches them, **persists the last good copy** in its `settings` table, and always applies its own
copy of the seed, even with no pool.

**Who may set a name.** Miners: the aged-proof chat gate minus the chat switch, as §19.16
(`chatStatus(s, { ignoreChatSwitch: true })`). Guests: their sign-up name is their first nickname; changing
it needs a signed-in guest session and nothing more. Both: not `nick_blocked`, `nicknames_enabled` on, and
**one change per `nickname_change_days`** (default 7, range 0–90; sign-up counts as a change). Removing your
own name is always allowed. **Refused attempts are capped at 10 per account per UTC day** so the list
cannot be probed; refused text is never stored.

**Admin** (games admin routes via the proxy; all **step-up** — none is in `FAST_WRITES`, so the pool code
does not change):

| Action | Effect |
|---|---|
| list + search | live names, removed names, banned names, blocked players; full address / guest id, `shown_as` |
| remove `{reason?}` | the live name → `removed`; the reason is shown to its owner |
| ban name `{reason?}` | inserts the matching form into `banned_names` AND removes the current holder; no spelling with the same matching form can be taken again |
| unban name | deletes the row; nothing is restored |
| block / unblock player | `players.nick_blocked`; blocking also removes the live name |

**Moderators (D21 amended):** `POST /play/api/mod/messages/:id/remove-name { reason? }` — the author of a chat message, like mute (built so in C3; this sketch said `/mod/nickname/remove { target }`, but a moderator never holds a full address — §19.15 *Part C3* #8) — remove only; refused on a
moderator's own name, another moderator's and the operator's; one `mod_actions` row as `mod:<address>`.

**Display.** `names.label(id)`: miner → mask, or `Nick (grin1abcd…wxyz)`; guest → `Nick · guest`, or
`Guest-XXXX` (4 base32 characters derived from the id; a label, not an identity); deleted → "deleted guest".
With `nicknames_enabled` off every surface shows the bare mask / `Guest-XXXX`. Uniqueness covers miners and
guests together, so a guest cannot be "Alice" while a miner is.

**Schema v4 — the sketch C0 wrote; the binding text is now §19.4 (C3 — `banned_by`, two refusal-counter columns and a data step were added, §19.15 *Part C3* #10):**

```sql
CREATE TABLE banned_names (
  norm TEXT PRIMARY KEY, name TEXT NOT NULL, banned_at INTEGER NOT NULL, by TEXT NOT NULL, reason TEXT
);
-- players gains nick_blocked INTEGER NOT NULL DEFAULT 0 (0/1) + the last nickname change time (cooldown)
-- nicknames keeps its states; 'pending' simply stops being written
```

**Migration of Part 12 rows (in the v4 migration).** `pending` → run the v2 checker: pass (and not taken) →
`approved`; fail → `rejected`, reason `rule_v2`. A live name failing the v2 rule (a space, `-`, `_`, `&`,
`'`, two characters) → `removed`, reason `rule_v2`. Nothing is deployed, so no real player loses a name, but
the rule is written so a box that did install Part 12 is migrated deterministically.

#### 19.17.6 Donor names (D29) — kind = name only

*Built 2026-10-04 (Part C4); where the build differs from the text below — the ban table's name, a separated word
counting as "whole", which refusals wait for the proofs, the migration's reason text — §19.15 *Part C4* wins.*

- **Shape unchanged (operator, C0):** §18.5 — trim, collapse whitespace, 2–32 characters of
  `A–Z a–z 0–9 space - _ . & '`, at least one letter or digit, case kept. The matching form removes the
  separators (space `- _ . & '`) before the leet fold, so `Acme & Co.` and `ACME-co` collide.
- **Checks:** the pool copy of the §19.17.5 rule with the donor shape: address-like, reserved (§16.4's
  `RESERVED` + the pool name, under the Scunthorpe rule), `names.blocked_words`, a **banned donor name**,
  and **taken** — another address's live donor name with the same matching form (today only a flag,
  `same as an approved donor`, now a refusal). Donor names and game nicknames live in different services
  and are **not** checked against each other (D5).
- **State machine change, names only:** submit → check → `approved` at once (the previous approved →
  `replaced`), or a 400 with the rule message (generic for list and reserved hits). `pending` is no longer
  written for `kind='name'`, and a refused name's text is not stored. The request log, the audit rows and
  `requireBothProofs` stay. **One change per 7 days** — a code constant, not a setting (one more form field
  for a knob nobody turns; promote it if asked).
- **Dots stay** (the operator kept the set): a donor name can still spell a domain. Links are never made
  clickable, and post-moderation removes a scam; recorded as accepted.
- **Admin:** the donors page gets a **Live names** list with remove (the reason shown to the donor), **ban
  name** (C4 chooses between a pool `banned_donor_names` table and one banned-names table with a scope
  column, and records why) and **block donor** (the existing `donor_blocks`). The review queue then holds
  banners only. All step-up, as today.
- **Migration (C4):** a `pending` name request is run through the checker (pass → `approved`, fail →
  `rejected`, reason `rule_v2`). Already-approved names are **kept** — a human approved them — and the admin
  list flags any `same_as` pair. `donor_name_blocklist` is retired into `names.blocked_words`: entries the
  operator added beyond the seed are carried over once.
- **Copy:** the donate page and the account page's Donor profile stop saying that names wait for review;
  banners still do. CMS defaults are seed-once, so an installed pool keeps its saved text — C4 records the
  operator note.

#### 19.17.7 The floating chat bubble (D23)

- **Files.** `/play/js/chat-bubble.js` + `/play/css/chat-bubble.css`, in the games tree, deployed and
  `?v=` stamped with the shell. The panel (`play-chat.js`) and the bubble share one chat core (C7 factors
  it); no copy.
- **Loader (pool).** After the branding payload lands, `public-shell.js` / `branding.js` insert the bubble
  script **only** when `games.chat` is true, the effective mode is `on` — or `preview` **and** the
  localStorage flag `grin_play_preview` is set (the /play/ shell sets it when it loads in preview) — and the
  page is not `data-untrusted-html="exempt"`. Every storage access is in `try/catch`; a throw means "not
  set". The loader is on C1's script-creator allowlist; a fixed path, never a URL from a payload.
- **Pages.** Every page that loads `public-shell.js`, except the exempt ones (the pool `login.html`; /play/
  has its own panel). The account page **does** carry it (D22 removed the reason to exempt it).
- **Signed-in hint.** The session cookie is `HttpOnly`, so the bubble cannot see it. A localStorage hint
  (`grin_play_signed_in`, set on sign-in by the shell or bubble, cleared on logout or a 401) decides whether
  a closed bubble polls at all. It holds no token; a stale hint costs one 401 and clears.
- **Polling budget:** closed + not signed in → **no requests**; closed + signed in → the change feed every
  **60 s** (for the unread dot); open → the panel's cadence; hidden tab → paused (`visibilitychange`).
  Open / closed is remembered per viewer (localStorage, `try/catch`).
- **Sign-in inside the bubble:** Miner tab (address + proof) and Guest tab (name + password), posting to the
  same login routes; "Create an account" links to `/play/#signup`. Moderator tools stay on /play/ (a link).
  The line *"The operator will never ask you for funds, keys or seeds in chat."* is always visible.
- **Layout.** Closed = a small button bottom-right with an unread dot; open = a panel on desktop, a
  full-screen sheet at ≤ 600 px; Esc closes and focus returns to the button; aria labels. Closed, it must not
  cover the account page's P-04 money buttons or the cookie/notice banners at 390 px.
- **Security (§19.13 #30):** `textContent` only; no session token or full address in the DOM; the cookie
  stays `Path=/play/` (requests from a pool page to `/play/api/…` carry it; the pool's own routes never
  see it).
- **As built (C7, 2026-10-04):** the loader is `loadChatBubble` in `branding.js`; the bubble shares
  `play-chat-core.js` with the panel; the CMS page/post bodies — the one operator-markup sink left on these
  pages — render in a frame sandboxed without `allow-scripts` (D22-4). Departures → §19.15 *Part C7*.

#### 19.17.8 Header group (D31)

`public-shell.js` NAV: the group today labelled **Prize Pool** (🎁) is relabelled **Community** and gains
**Play** as a third child, after Fortune Board and Contribute (the icon is C2's choice — the gift box was
the prize pool's). The standalone Play item goes. Per-child gates: Fortune Board and Contribute keep
`data-incentives`; Play keeps `data-games`. `applyIncentivesNav` / `applyGamesNav` stop hiding the whole
group on their own flag: the group shows when at least one child shows, and is **hidden, not empty**, when
none does. The mobile icons-only header still works, and the group still lights as active on /play/. The
footer keeps Play games-gated wherever it renders.

| Incentives | Games (effective) | Group | Children shown |
|---|---|---|---|
| on | on | shown | Fortune Board, Contribute, Play |
| on | off / preview | shown | Fortune Board, Contribute |
| off | on | shown | Play |
| off | off / preview | **hidden** | — |

#### 19.17.9 Settings added or changed

| Owner | Key | Default | Range / rule |
|---|---|---|---|
| pool `games` | `mode` | **`on`** (was `off`) | `off`\|`preview`\|`on` |
| pool `games` | `chat_enabled` | **`true`** (was `false`) | bool |
| pool `names` (new) | `blocked_words` | empty (the seed applies anyway) | ≤ 500 × ≤ 32, `*`/`=` prefixes |
| pool `analytics` | `custom_head_html`, `custom_body_html` | **removed** (D22) | a stored value is ignored |
| pool donors | `donor_name_blocklist` | **retired** into `names.blocked_words` (C4) | — |
| games | `plays_balance_cap` | **999** (was 100) | 1–10000 |
| games | `guest_signup_enabled` | true | bool (added by C0) |
| games | `guest_signups_per_ip` | 3 | 1–10 per 24 h |
| games | `signup_pow_bits` | 18 | 14 (floor constant) – 26 |
| games | `guest_daily_plays` | 5 | 0–100 |
| games | `chat_guests_enabled` | true | bool |
| games | `guest_chat_min_age` | 86400 | ≥ the 1 h floor constant, ≤ 30 d |
| games | `guest_idle_days` | 180 | 30–3650 |
| games | `nickname_change_days` | 7 | 0–90 |
| games DB | `meta.launch` | `preview` | `preview`\|`on` (§19.17.2) |

#### 19.17.10 What does not change

Money (D32). The pool's three internal routes keep their shapes; `config` only gains fields. `FAST_WRITES`
is unchanged — every new admin write is step-up by default. The frame sandbox, the shell CSP and the
`/play/` nginx locations are unchanged apart from one sign-up rate zone (C5). Donor banners (D29). The
miner earning rule (D10) apart from the balance cap. O2 stays open until C9.

## 20. Node availability — pool-side recording, recorder ingest, homepage `up_days` (DESIGN 2026-10-03; Part 6 backend + Part 7 admin page + Part 8 homepage lamp BUILT 2026-10-03, R2 review 2026-10-03, never run)

**The node-box half** is the read-only node event recorder: its state machine, ledger schema,
classes and evidence are in `script086_design.md` §8. This section covers only what the pool adds.

### 20.1 Why the pool records too

The recorder sees the node from the node box: the process, the log, the kernel. The pool sees it
as a **consumer**. It asks "could the pool get a status from its node just now?", and the answer
also covers a secret that drifted, a node dir that moved, or a pool-side fault. The two observers
legitimately disagree:

- A planned toolkit stop is `stopped` (not counted) for the recorder. For the pool and its miners,
  it is still minutes without a node.
- A pool that cannot authenticate is a fault for the pool and a healthy node for the recorder.

So each source keeps its own rows and its own uptime %.

### 20.2 `node_events` model

The table is a versioned migration in `lib/db.js`. Retention is 2 years, added to `lib/retention.js`.

```
node_events(id INTEGER PK, network TEXT, source TEXT CHECK(source IN ('pool','recorder')),
            started_at INTEGER, ended_at INTEGER NULL, duration_s INTEGER NULL,
            state TEXT, class TEXT NULL, origin TEXT NULL CHECK(origin IN ('transport','node_reply','auth')),
            detail TEXT NULL,               -- ≤ 300 chars, built from tags, never err.message, no IPs
            recorder_event_id TEXT NULL UNIQUE)
INDEX (network, started_at)
```

**Pool-side probe.**

- *Cadence:* its own 30 s `getStatus()`. It is independent of the `node_down` alert toggle
  (`alert-monitor.checkNodeHealth()` runs only when that alert is enabled).
- *Not shared:* the probe does not share or reuse `block-monitor`'s `getStatus()` call. That module
  sits on the money path (rewards, orphan detection), and coupling a recorder to its timing is the
  kind of change R2 must treat as HIGH.
- *Load:* the extra cost is one localhost RPC per 30 s and a DB write only on transitions.
- *Strikes:* 2 before DOWN, backdated to the first failed probe, the same rule as the recorder.

**Origin and class come from tags, never from message text** (memory
`project_pool_node_error_classification`):

| `getStatus()` result | `origin` | pool `class` | Counted in the pool's uptime %? |
|---|---|---|---|
| `ok: true` | — | — (`up`) | — |
| `transport: 'timeout'` | `transport` | `timeout` | yes |
| `transport: 'refused'`, `downState()` = `starting` | `transport` | `starting` | yes (the pool view does not know about plans) |
| `transport: 'refused'`, otherwise | `transport` | `refused` | yes |
| `transport: 'auth'` (**new tag**, below) | `auth` | `auth` | **no**: the node is fine and a secret is wrong. Shown as its own fault |
| `transport: 'other'` | `transport` | `other` | yes |
| node replied (`nodeReplied: true`: an envelope error such as `-32601`, or `result.Err`) | `node_reply` | `node_error` | yes |

**The new `auth` tag** (design §8.13 F-4 in `script086_design.md`).

- *Today:* a 401/403 is thrown as `HTTP 401: …` and tagged `transport: 'other'`, the same tag as a
  5xx or an nginx error page.
- *The change:* Part 6 attaches the HTTP status to the error inside `_rpcCall` before
  `transportFailure()` wraps it, and `classifyTransport()` returns `'auth'` for 401/403.
- *Behaviour that must not move:* `downState()` keeps mapping it to `'offline'`, so the public
  lamp does not change. Every money path keeps seeing `nodeReplied: false`, so their behaviour does
  not change either.

**Stratum drops.** A `node-stratum-client` close/reconnect while an outage is open is appended to
that row's `detail`. When the API stayed up, it becomes a short `stratum_drop` row
(`state='degraded'`) that the pool's uptime % does not count.

### 20.3 Recorder ingest

The recorder ingest reads `/opt/grin/node-events/<pool network>/ledger.jsonl` every 60 s.

**Permissions** (design §8.13 F-5 in `script086_design.md`). The `grin-pool-manager` unit is
`ProtectSystem=strict` with no `InaccessiblePaths`, so the files are readable as long as the
recorder keeps its 0755 dirs and 0644 files. No unit change is planned. Fact-finding item G
confirms the live unit matches the template.

**Reading the file.**

- The byte offset and inode persist in the DB.
- An unchanged inode means read from the offset. The pool never advances past the last `\n`, so
  a partial trailing line waits for the next tick.
- A changed inode means a rotation (the recorder's logrotate is rename-based). The pool first
  finishes `ledger.jsonl.1` if that file's inode equals the stored one, then starts the new file at
  0.
- A size below the offset means truncation. The pool resets to 0, and the `UNIQUE` key absorbs the
  replays.

**Every line is untrusted input.**

- Each line is validated against the `v:1` schema in `script086_design.md` §8.8:
  - enums are checked against allow-lists;
  - integers must pass `Number.isSafeInteger`;
  - strings are clamped.
- A malformed line is dropped. The pool writes one log line per file per hour, not one per line.
- Inserts are `INSERT OR IGNORE` keyed on `recorder_event_id`.

**Mapping recorder events to rows.**

- `down` opens a `source='recorder'` row.
- The `up` carrying `outage_id` closes the row whose `recorder_event_id` equals that id.
- `reclass` updates the class.
- `stop` / `start` / `boot` / `gap` become `state='planned'` / `'unobserved'` rows, shown and never
  counted.

**Absent or unreadable files.** A missing ledger is normal: no recorder is installed, and the UI
says so. An unreadable one logs once, with the cause and the fix.

### 20.4 Merge rule: shown side by side, never de-duplicated

- Pool rows and recorder rows are **never merged into one row**, and neither source's counts are
  adjusted by the other. They are different observers, and their disagreement is information:
  - pool down + recorder up → an auth, pool-side or path problem;
  - pool down + recorder `stop` → planned maintenance that miners still felt.
- The admin page shows two uptime figures and two lanes on one timeline.
- The page may **annotate** a pool outage that overlaps a recorder `stop` / `boot` ("overlaps a
  planned stop"). An annotation never changes a number.

### 20.5 The public `up_days` contract

`GET /api/pool/status` → `node.up_days` is an **integer ≥ 0, or `null`**. It is the only uptime
field in any public response. No timestamp, restart time, uptime in seconds, class or error string
appears publicly (memory `project_health_api_security`).

**Source order:**

1. The recorder's `status.json` for the pool's network, if `now − updated ≤ 120 s` and its
   `state = up`. The pool uses its `up_since`.
2. Otherwise, the pool's own "reachable since": the end of the last counted pool-side outage. It is
   never earlier than the first pool probe ever stored, so a fresh install cannot claim time it did
   not observe.
3. Otherwise `null`. That includes "node not reachable right now".

**Quantised to the UTC day.**

- *Formula:* `up_days = max(0, floor((utc_midnight_today − up_since) / 86400))`.
- *Why:* a plain `floor((now − up_since) / 86400)` would tick over at the exact time of day the node
  restarted. One visitor polling across that moment would learn the restart time to within the
  15 s cache.
- *What the formula does instead:* it flips only at 00:00 UTC for every node, so the value says
  which day, never which hour. It understates by at most one day. `0` is a real value, meaning
  "came up today or yesterday"; `null` means unknown.

**Display** (Part 8, P-02 `#an-node` lamp):

| `up_days` | Shown |
|---|---|
| `0` | `up <1 d` |
| 1–59 | `up N d` |
| 60 to below 730 | `up N mo` (`floor(days / 30.44)`) |
| 730 and above | `up N.N y` (`days / 365.25`, floored to one decimal) |
| `null` | no uptime text at all, never `up 0 d` |

**Part 8 as built (2026-10-03, never run):** the uptime is its own `span.lamp-up` row under the peer
count, not an inline ` · up N d`, and the hover text says "at least N days". The detail and the
reasons are in `script07_implementation.md` §10.15 *Part 8*.

### 20.6 Admin APIs (Part 6) and page (Part 7)

- `GET /api/admin/node-events?network=&range=7d|30d|90d|1y` returns both sources' rows.
- `GET /api/admin/node-availability?range=` returns, per source: uptime %, counts by class, MTBF,
  longest outage, and a daily availability series.
- Both use the existing admin middleware and rate limit.
- The page `admin-panel/node-availability.html` sits in the Health nav group. Its KPIs show the two
  sources side by side. When no recorder is installed, its empty state names hub 08 → Diagnostics.
- **Part 7 as built (2026-10-03, never run):** the page sits in the Dashboard nav group, under
  System Health. The detail is in `script07_implementation.md` §10.15 *Part 7*.

### 20.7–20.8 As built → `script07_implementation.md` §10.15

The Part 6 as-built deltas (formerly §20.7) and the R2 review of Parts 6–8 (formerly §20.8) moved to
`script07_implementation.md` §10.15 on 2026-10-03, with the Part 7 and Part 8 notes. Where the
build differs from §20.1–§20.6, the implementation doc wins: for example, `node_events.state` has
seven values there, not the few named above.

## Appendix — Solo private pool flowchart, merged from flowcharts/script07_mining_solo_flow_chart.txt 2026-07-09

```text
================================================================================
 07_grin_mining_solo.sh — Solo Private Pool Flowchart   [current as of 2026-07-06]
================================================================================

 Configure & manage solo mining on a Grin node: enable the node's built-in
 stratum, set the coinbase wallet, publish the port, and (optionally) run a
 combined coinbase wallet listener, a stats web page, watchdogs, and a payout
 split for a trusted group.

 Launch:  grin-node-toolkit → 07 Mining hub → Solo private pool
          Optional arg:  07_grin_mining_solo.sh lan   → LAN stats-page mode
          (SOLO_NET_MODE = "public" default | "lan"; only the stats page differs —
           every mining mechanic is identical in both modes.)

 MENU MODEL — network-as-parent (mirrors 059 Grin Drop)
   The top screen picks a network ONCE (1/2); inside that branch SOLO_NETWORK is
   set and inherited, so per-action network prompts are gone. Cross-network tools
   (both-net status, the unified stats page, global watchdogs, maintenance,
   payouts) live on the top screen, not inside a branch. All-numeric keys for
   main actions; letters (A / C) for guided-start and destructive/admin.

 Entry
   └─> main("$1")               $1 == "lan" → SOLO_NET_MODE=lan
         ├─> direct-launch mode guard (skip when SOLO_LAUNCHED_VIA_HUB set):
         │     warn if a deployed stats vhost's mode ≠ the launched mode
         └─> loop: show_menu()  ← network-select screen, loops until 0

  ┌─────────────────────────────────────────────────────────────────────────┐
  │  TOP MENU — Network-select screen  (show_menu / main dispatch)          │
  └─────────────────────────────────────────────────────────────────────────┘
   Header shows show_compact_status(): per-net Node RUNNING/OFF (ss only, no API
   call) + Stratum LISTENING/OFF + bind PUBLIC/LOCAL.

   A) Start here — node check ............ solo_node_precheck()
   1) Configure solo pool Mainnet ........ _set_solo_net mainnet → solo_net_menu()
   2) Configure solo pool Testnet ........ _set_solo_net testnet → solo_net_menu()
   3) Deploy stats web page .............. solo_deploy_stats_page()   (both nets)
   4) Node, Wallet & Mining Status ....... show_node_status()        (both nets)
   5) Watchdogs (global) ................. watchdog_menu()
   6) Maintenance ........................ maintenance_menu()   (lib/07_solo_backup.sh)
   7) Payouts & settlement ............... solo_settlement_menu()     (mainnet)
   C) Clean up solo mining ............... solo_cleanup()   (Danger Zone)
   0) Back to main menu

  ┌─────────────────────────────────────────────────────────────────────────┐
  │  PER-NET BRANCH  (after 1/2 — SOLO_NETWORK set)   solo_net_menu()        │
  └─────────────────────────────────────────────────────────────────────────┘
   Header shows _show_node_info(net): Node / Wallet listener / Stratum / miners
   + toml enable/bind/wallet/burn for the chosen net.

     1) Wallet          ▸  wallet_menu()      (combined coinbase listener)
     2) Stratum         ▸  stratum_menu()     (setup&publish / config / restrict)
     3) Terminal Stats  →  solo_live_stats(net)   (live dashboard, this net)
     0) Back to network select

================================================================================
 A) START HERE — NODE PRE-CHECK   solo_node_precheck()
================================================================================
 Read-only "step 0": solo mining needs a fully-synced node on THIS server.
   ├─> _precheck_one_net(mainnet, 3413, primary)
   │     ├─> ss :3413 → RUNNING? else point at Script 01 (real mining needs it)
   │     └─> gnc_owner_get_status → sync_status / tip.height / connections
   │           no_sync → "✓ Ready to mine" ; *_sync → "⏳ still syncing, wait"
   ├─> _precheck_one_net(testnet, 13413, optional)  [same; "spin one up too"]
   ├─> _precheck_next_action → most-useful next step (mainnet priority)
   └─> can launch Script 01 in-process (build/sync a node without leaving 07)

================================================================================
 1) WALLET — Central coinbase listener   wallet_menu()   (lib/07_solo_wallet.sh)
================================================================================
 Runs the whole wallet flow inside Script 07: init/recover → save pass → patch
 toml → start ONE COMBINED Owner+Foreign listener that receives coinbase and stays
 alive across reboots/crashes. Dir: /opt/grin/solowallet/<net>/.

 Header: sw_listener_status (both nets) + sw_autostart_status + sw_watchdog_status.

   1) Setup / Recover ....... sw_setup(net)
        1. grin_wallet_install.sh → download + verify grin-wallet binary
        2. init (grin-wallet init -h)  OR  recover (init -hr from seed)
        3. _sw_read_new_pass → save passphrase to <dir>/.passphrase (chmod 600)
        4. patch grin-wallet.toml: node_api_secret_path → node's .foreign_api_secret
           + owner_api_include_foreign = true   (mount Foreign on the Owner port)
        5. grin_install_secret_sync → box-wide secret self-heal
        6. sw_port_collision_check, then start the combined listener
   2) Start listener ........ sw_listener_start(net)  → listen.sh in tmux
   3) Stop listener ......... sw_listener_stop(net)
   4) Show address .......... sw_show_address(net)   (grin-wallet -p … address)
   5) Enable boot autostart . sw_autostart_enable(net)   @reboot tag-guarded cron
   6) Disable boot autostart  sw_autostart_disable(net)
   7) Install listener watchdog  sw_watchdog_install    */5 relaunch if port down
   8) Remove listener watchdog   sw_watchdog_remove
   0) Back

 ─── COMBINED LISTENER — `-p owner_api`, and WHY NOT ECDH LIKE THE PUBLIC POOL ──
   The node funds coinbase via the wallet FOREIGN API (build_coinbase). Solo runs:
       grin-wallet <net_flag> -p <pass> owner_api   (owner_api_include_foreign=true)
         → Owner API + mounted Foreign API BOTH on 3420 / 13420
           (NOT the old bare-`listen` Foreign 3415 / 13415)
   · `-p` opens the wallet at startup, so the mounted Foreign build_coinbase works
     IMMEDIATELY — no unlock step. Verified testnet 2026-07-06 (CbData on 13420).
   · Launcher listen.sh reads the pass from .passphrase (not in the tmux argv),
     but the wallet process still shows `-p <pass>` in `ps aux` / /proc/cmdline.

   The public POOL runs the identical owner_api+include_foreign listener but DROPS
   `-p` and unlocks at runtime via an ECDH `open_wallet` helper (Owner API v3:
   init_secure_api → key exchange → open_wallet, keychain mask held in memory).
   Solo deliberately does NOT copy that:
     · ECDH open_wallet is an Owner-API SESSION op — it needs a persistent client
       to run the handshake and hold the mask. The pool already has one (its
       Node/Express backend). Solo has NO backend; adding a Node service JUST to
       unlock a wallet pulls in a dependency solo is designed to avoid.
     · `-p owner_api` reaches the SAME end state (wallet open, Foreign coinbase
       live) with a saved pass file and zero moving parts.
   TRADE-OFF: the saved-pass model exposes the passphrase in the listener's argv
   (same hot-wallet rationale the pool documents in script07_security_audit.md).
   grin-server.toml wallet_listener_url MUST be the BASE URL http://127.0.0.1:3420
   (node appends /v2/foreign itself; a stored /v2/foreign or old :3415 → no coinbase).

================================================================================
 2) STRATUM — enable + publish the node's built-in stratum   stratum_menu()
================================================================================
 Header: show_compact_status(). Setup and Publish are now ONE action.

   1) Setup & Publish ..... _stratum_dispatch setup <net> → _do_setup_stratum()
        find_grin_server_toml(net, api_port)  [running-PID → readlink → scan → prompt]
        ├─> enable_stratum_server = true
        ├─> wallet_listener_url = base URL (default http://127.0.0.1:3420, 13420 test)
        │     normalises legacy values: strips /v2/foreign, snaps old :3415/:13415
        │     → Owner port (combined listener), else node calls a dead port
        ├─> burn_reward = false  (forced — never prompt; can't burn real rewards)
        └─> flows into _enable_stratum():
              ├─> _show_stratum_port_guide → confirm
              ├─> stratum_server_addr = "0.0.0.0:<port>"
              ├─> firewall: 1) all IPs (ufw/iptables, -C guarded) · 2) one IP · 3) skip
              ├─> graceful_restart_grin(api_port, net)   [TERM→wait→tmux restart]
              ├─> print miner connect box: stratum+tcp://<public|LAN ip>:<port>
              │     + worker/login hint "<nickname>.rig1" (dot groups payout split)
              │     + Cloudflare "DNS only (grey cloud)" warning (public mode)
              └─> _solo_watch_for_miner → optionally tail for first miner connect
   2) Manual config ....... _do_configure_stratum()   single-field editor
        show fields 1-4 → pick one → sed patch → graceful_restart_grin
   3) Restrict ............ _disable_stratum()
        stratum_server_addr = "127.0.0.1:<port>" · ufw delete · graceful_restart_grin
   0) Back

================================================================================
 3) TERMINAL STATS   solo_live_stats(net)     (per-net branch ▸ 3)
================================================================================
 Live in-terminal dashboard (Enter = refresh, 0 = return).
   ├─> read .api_secret + .foreign_api_secret from /opt/grin/node/<net>-prune/
   └─> each refresh:
         ├─> curl 127.0.0.1:<api>/v2/owner get_status → height, total_difficulty, peers
         ├─> _solo_network_hashrate: two get_header (Foreign API) over a 60-block
         │     window → Cuckatoo32 GPS = diff_delta × 42 / dt / 16384 (G/s·kG/s·MG/s)
         └─> ss ESTAB on stratum port → miners connected

================================================================================
 3) DEPLOY STATS WEB PAGE   solo_deploy_stats_page()     (top menu ▸ 3)
================================================================================
 ONE unified static page (nginx) shows mainnet + testnet side by side. No Node.js,
 no DB, no systemd. nginx injects Basic Auth per network so the secret never
 reaches the browser. Public mode = domain + Let's Encrypt; LAN mode = plain HTTP.

   ├─> auto-detect nets: have_main/have_test from /opt/grin/node/<net>-prune/.api_secret
   │     (a missing net gets no proxy location → greys out on the page)
   ├─> nginx_install_with_certbot (install up front; bare node has no /etc/nginx)
   ├─> ADDRESS:
   │     LAN mode  → prompt LAN IP (_detect_lan_ipv4) + HTTP port (default 80)
   │     public    → Cloudflare/DNS note → prompt subdomain → nginx_validate_domain
   │                 → DNS pre-check (getent hosts)
   ├─> cp index.html + setup-solo-mining.html + logo → /var/www/grin-solo-mining-stat
   ├─> write data/config.json: stratum ports + advertised IP + slogan + portcheck_api
   │     (collector reads it; editable live — no redeploy for slogan/ports)
   ├─> _solo_prompt_payout_split → write/remove /opt/grin/conf/grin_solo_payment.json
   ├─> install collector (see COLLECTOR below) → cron every 5 min + initial run
   ├─> _solo_prompt_access_lock (public mode) → apr1 htpasswd (see ACCESS LOCK)
   ├─> write vhost:
   │     · per detected net: location = /api/status/<net> → node Owner API get_status
   │       (Basic Auth injected; rate-limit zone solo_stats_api) + wallet liveness probe
   │     · location / → static web_dir ; chmod 600 (b64 token in conf)
   │     · LAN: listen <ip>:<port>   ·   public: listen 80 (certbot adds 443)
   ├─> nginx_enable_site (include + symlink + nginx -t + reload)
   └─> public mode: nginx_run_certbot(subdomain, --redirect) → 443 + HTTP→HTTPS
         on failure: page stays live over HTTP, prompt to fix DNS & retry

   Reused shared-lib helpers (lib/nginx_shared_helpers.sh): nginx_install_with_certbot ·
   nginx_validate_domain · nginx_enable_site · nginx_run_certbot · nginx_test_reload.

 ─── COLLECTOR   lib/07_mining_block_collector.py ──────────────────────────────
   Installed → /usr/local/bin/grin-solo-mining-collector.py (+ wrapper), cron */5,
   state /opt/grin/solo-stats/. Parses the node log → per-net SQLite
   (solo_mining_stats_<net>.db) + derived JSON the page reads:
     blocks_<key>.json · miners_<key>.json · poolstats_<key>.json (miningpoolstats
     pollable) · split_main.json (payout split, mainnet only, when enabled).
   Also maintains the payout ledger (matured-block earnings, chain-verified at
   maturity) and answers the settlement CLI (--list-balances / --record-payment /
   --list-payments) used by menu 7.

 ─── PAYOUT SPLIT (mainnet, display + running balance)  grin_solo_payment.json ─
   Opt-in toggle (one prompt in deploy). For a TRUSTED friend group sharing the
   solo pool: solo always pays ONE coinbase wallet; the split just shows who earned
   what so the operator settles by hand. NO Grin addresses stored, ever.
   · Identity = nickname = worker text BEFORE the first dot (alpha.01, alpha.02 →
     alpha). Automatic grouping; nothing to pre-register.
   · Fairness = matured-block reward (60 GRIN, no halving) split by work-share
     (difficulty-weighted, not raw share count). Only MATURED (chain-verified,
     1440-block) blocks count → an orphan never inflates a split.
   · Running balance per nickname: All-time earn − Paid = To be Paid (see menu 7).

 ─── ACCESS LOCK (public mode)  STATS_HTPASSWD /etc/nginx/grin-solo-stats.htpasswd ─
   Opt-in HTTP Basic Auth over the certbot HTTPS (openssl passwd -apr1 → no
   apache2-utils). Default: PROTECT location / + /api/* + split_main.json; leave
   poolstats_*.json PUBLIC so miningpoolstats.com can still poll. Optional
   sub-choice hides poolstats too. HTTPS-only (the :80 block 301s first).

================================================================================
 4) NODE, WALLET & MINING STATUS   show_node_status()   (top menu ▸ 4, both nets)
================================================================================
   _show_node_info(net) per network:
     ├─> Node   : ss :api → RUNNING (PID, binary, dir, tmux attach hint via
     │            gnc_has_grin_session → gtmux|tmux) / NOT RUNNING
     ├─> Wallet : ss :3420/13420 → LISTENING (combined Owner+Foreign) / NOT RUNNING
     │            / not configured
     ├─> Stratum: ss :stratum → LISTENING + ESTAB miner count / not listening
     └─> toml   : enable / bind / wallet_listener_url / burn

================================================================================
 5) WATCHDOGS (global)   watchdog_menu()   (top menu ▸ 5)
================================================================================
 Four independent keepalives; header shows the state of each.
   1/2) Node-sync watchdog ....... gnk_watchdog_install / _remove   (grin_node_keepalive.sh)
          restarts a WEDGED node (height not advancing vs external reference),
          not just a dead PID. External ref = 2+ THIRD-PARTY nodes (NEVER the
          operator's own api.grin.money — circular). Fetch failure ≠ restart.
          Anti-flap: state file + cooldown + post-restart grace.
   3/4) Node boot-autostart ...... gnk_autostart_enable / _disable  (per net / both)
          ONE shared tag-guarded @reboot cron (also managed by Script 03).
   5/6) Wallet-listener watchdog . sw_watchdog_install / _remove   (*/5, relaunch 3420/13420)
   7/8) Stratum watchdog ......... solo_stratum_watchdog_install / _remove
          (*/5, /etc/cron.d/grin-stratum-watchdog — WARN if stratum drops / drifts)
   0) Back
   NOTE: candidate to fold 1+5+7 into ONE "solo health" */5 cron eventually.

================================================================================
 6) MAINTENANCE   maintenance_menu()   (top menu ▸ 6, lib/07_solo_backup.sh)
================================================================================
 Encrypted backup of everything a solo miner can't recreate.
   1) Deploy new code ...... solo_deploy_code()   re-copy collector .py + web page
                              from the checkout (git pull via Admin 08→8 first)
   2) Backup now ........... sb_backup_now()   AES-256-CBC PBKDF2-600k, pass on fd:3
        archives /opt/grin/solowallet (wallets+binary+seed+.passphrase),
        /opt/grin/solo-stats (SQLite, online-backup snapshot), grin_solo_payment.json
        → /opt/grin/backups/grin_solo_backup_<DDMMYYYY>.tar.gz.enc (600)
   3) Restore from backup .. sb_restore()   pick file → type personal key → extract
                              to original paths (tar -C / -p)
   4) Schedule daily ....... sb_schedule()   cron + <keep>-archive retention
   5) Settings ............. sb_settings()   personal key · retention · list
   6) Show recovery seed ... sb_show_seed(net)   the ultimate wallet backup
   0) Back
   Password model: <personal_key><DDMMYYYY>. personal_key stored b64 in
   grin_solo_backup.conf (600) for the unattended cron; typed by hand on restore.
   NOT backed up: node dir / grin-server.toml (re-publish stratum after restore),
   nor the backup key itself.

================================================================================
 7) PAYOUTS & SETTLEMENT   solo_settlement_menu()   (top menu ▸ 7, MAINNET)
================================================================================
 Requires the mainnet stats DB (deploy stats page ▸ 3 with payout split enabled).
   Shows a per-nickname running balance:
     All-time earn (matured-block rewards) − Paid (recorded) = To be Paid.
   1) Record a payment ..... _settlement_record_payment()
        numbered picker (biggest To-be-Paid first) → nickname → amount
        (Enter = full owed) → note → confirm → collector --record-payment
        → refresh split_main.json now (don't wait for cron)
   2) Payment history ...... _settlement_show_history()   latest 20, newest first
   0) Back
   Pay each nickname OUT-OF-BAND (one normal Grin tx from your own address book),
   then record it here so 'To be Paid' drops. No address is ever stored or shown.

================================================================================
 C) CLEAN UP   solo_cleanup()   (top menu ▸ C, DANGER ZONE)
================================================================================
 Removes solo infra (stratum config revert, collector bin/wrapper/cron + state,
 stratum watchdog, stats vhost/web dir) with per-group confirmation. KEEPS the
 node + grin-server.toml, the wallet seed (/opt/grin/solowallet), and encrypted
 backups (/opt/grin/backups) + key. Full destructive wipe lives in Script 08del.

================================================================================
 INTERNAL HELPERS
================================================================================
  find_grin_server_toml(net, api_port)   ss PID → readlink /proc/pid/exe → toml;
        else scan known dirs by chain_type; prompt if multiple/none → FOUND_GRIN_TOML
  _resolve_stratum_toml(net, api_port)    non-interactive variant (status screens)
  graceful_restart_grin(api_port, net)    ss PID → binary/dir → tmux session →
        kill -TERM (wait 30s, -KILL) → SHELL=/bin/bash tmux new-session restart
  _find_grin_session_for_pid(pid)         map node PID → tmux session name
  _detect_public_ipv4 / _detect_lan_ipv4  advertised stratum host (Internet / LAN)
  _stratum_bind_line(toml, port)          PUBLIC/LOCAL/not-set for the status header
  sw_* (lib/07_solo_wallet.sh)            combined listener / cron / watchdog / address
  gnc_* (lib/grin_node_control.sh)        gnc_owner_get_status · gnc_has_grin_session
  gnk_* (lib/grin_node_keepalive.sh)      node boot-autostart + node-sync watchdog

  Sourced libs: nginx_shared_helpers · grin_node_secrets · grin_node_control ·
  grin_node_keepalive · 07_solo_wallet · 07_solo_backup · grin_wallet_install.

================================================================================
 PORT REFERENCE
================================================================================
  Stratum (miners → node)            Mainnet 3416   Testnet 13416
    grin-server.toml → stratum_server_addr
  Node Owner API (local — stats/watchdog/precheck)   Mainnet 3413   Testnet 13413
  Wallet combined listener — Owner API + mounted Foreign (coinbase delivery)
    Mainnet 3420   Testnet 13420
    grin-server.toml wallet_listener_url → http://127.0.0.1:3420  (node adds /v2/foreign)
    (was bare-`listen` Foreign 3415/13415 before the 2026-07-06 combined
     `-p owner_api` + owner_api_include_foreign change)

================================================================================
 SECURITY MODEL
================================================================================
  · Node .api_secret (/opt/grin/node/<net>-prune/) never leaves the VPS; nginx
    injects Basic Auth for /api/status → browser never sees it; conf chmod 600.
  · Wallet .passphrase (/opt/grin/solowallet/<net>/) chmod 600 — enables unattended
    `-p owner_api` boot; trade-off = passphrase in the listener argv (ps aux).
  · Stratum opened to 0.0.0.0 only when the operator runs Setup & Publish (firewall
    rule added then); Restrict reverts to 127.0.0.1.
  · Access lock (optional, public mode): apr1 htpasswd 640, HTTPS-only; keeps
    poolstats_*.json public for miningpoolstats unless the operator opts to hide it.
  · Payout split stores NO Grin addresses — nicknames + % + GRIN only.
  · Node-sync watchdog never trusts a bare PID and never uses the operator's own
    endpoint as the external truth (circular); external fetch failure ≠ restart.

================================================================================
 LEDGER / TIME conventions
================================================================================
  · Collector ledger day-keys + timestamps in UTC; the web page converts UTC →
    the viewer's local timezone for display.
  · Matured-block counting is chain-verified at 1440 maturity (get_block hash
    compare) so an orphan never inflates a payout.
  · Testing: local `bash -n` + /check + /review only (needs a Linux + root VPS to
    run); the operator runs live on the VPS.

================================================================================

```

================================================================================
 ABANDONED-BALANCE DISPOSITION + MANUAL PAYOUT  (add-ons, 2026-07-22)
================================================================================
Problem: the pool is custodial between credit and payout. A miner can accrue a
balance then vanish (lost seed/pass, abandoned rig). Left forever, these balances
bloat the ledger and sit as an unbacked-looking liability. Operator question:
what to do with them, correctly and defensibly?

DECISION (locked with operator, 2026-07-22):
  · An address with NO accepted share AND NO successful payout for `dormancy_months`
    (default 24), still holding a balance, is "abandoned".
  · Its balance is SWEPT and REDISTRIBUTED to miners active in the last
    `dormancy_active_window_days` (default 30), weighted by recent sustained work
    (hashrate_history — raw shares prune within ~a day, so they can't back a 30-day
    window; hashrate_history is kept 100d and is the same source the lottery uses).
  · Disposition is FINAL. The owner reclaims any time BEFORE it (account-page
    countdown + public masked list) by simply requesting a payout. NOT after.
  · Funds go to ACTIVE MINERS, NEVER the operator. This is the ethical anchor and
    the line the ToS/banner must state.
  · Why final-and-redistribute (not reserve, not reclaim-forever): the "redistribute
    + reclaim-forever" combo is exploitable — a whale can let one address go dormant,
    farm most of the redistribution back to its active addresses, then reclaim the
    original from pool funds. Making disposition FINAL kills the exploit (the faker
    just loses money waiting) while still rewarding the miners who secure the pool.
    OFF by default — enabling it is a deliberate, disclosed operator decision.

┌── REVISION 2026-07-22b (operator): DESTINATION CHANGED → COMMUNITY PRIZE POOL ──────┐
│ After discussion, the swept balance is NO LONGER split among active miners. It is    │
│ swept into the single `prize_pool` bucket instead — where it is given away through   │
│ the pool's existing, publicly-auditable draws (Pot A whale-cap + Pot B equal-chance).│
│ WHY the change (simpler + more transparent + fairer):                                │
│   · Deletes the entire recipient-selection engine — no equal-vs-weighted decision,   │
│     no Sybil-per-address hole (equal split would be farmable), no dust-spraying a     │
│     tiny balance across hundreds of miners (0.005 GRIN each = pointless + N log rows),│
│     no "no active recipients → defer" edge case. Prize pool always exists.            │
│   · Small dormant balances (the typical case — sub-threshold dust that could never    │
│     auto-pay) accumulate and are handed out in meaningful chunks, not sprayed.        │
│   · Small miners still get the "fair" outcome via Pot B equal-chance, but behind the  │
│     lottery's anti-Sybil gates (min-active-days + min-work) — not a raw money split.  │
│   · Still an INTERNAL transfer, still NEVER the operator. Because prize_pool is        │
│     excluded from custodial liability, sweeping there correctly REDUCES miner-owed.   │
│ LEDGER: per-source debit reference_type='dormant_sweep' UNCHANGED; the credit is now  │
│   a SINGLE row to prize_pool, reference_type='dormant' (was per-recipient             │
│   'dormant_payout'). Σdebit == the one credit → integrity invariant still nets 0      │
│   (INV_CASES sums credit/debit regardless of ref_type). remainder always 0,           │
│   recipient_count always 1. No reconciliation break; added prize.from_dormant to the  │
│   bucket breakdown for transparency.                                                  │
│ TRANSPARENCY (the point of the change): incentives.prizePoolStatement() = lifetime    │
│   in/out by source over the rollup horizon; public GET /api/pool/prize-pool +          │
│   donate.html D-05 panel; admin GET /api/admin/incentives/prize-pool statement +      │
│   settings-incentives.html breakdown. The earlier "whale exploit" rationale below is   │
│   now moot — a whale can't farm a lottery pot back the way it could a direct split.   │
└──────────────────────────────────────────────────────────────────────────────────────┘

GRANDFATHERING: the clock counts from max(last_activity, dormancy_policy_effective_at).
The first enabled run stamps `dormancy_policy_effective_at = now` and disposes NOBODY,
so every address gets a full window of runway after the policy goes live. Operators can
only ever push the anchor later (more runway), never retroactively shorten it.

LEDGER MODEL (why it's safe on the custodial books):
  · Disposition is an INTERNAL transfer: Σ debited from sources == Σ credited to
    recipients (rounding remainder handed to the top-weight recipient), so the
    reconciliation integrity invariant nets to exactly zero and the coins never leave
    the wallet. Fresh reference_types keep it OUT of the external IN/OUT flow:
      - debit  source     → reference_type='dormant_sweep'
      - credit recipient  → reference_type='dormant_payout'  (reference_id = batch id)
    reconciliation.js INV_CASES sums by event_type (credit +, debit −), so no change
    to reconciliation.js is needed; ledger-rollup keeps (addr,event_type,ref_type) as
    dimensions so the new types roll up automatically.
  · Guards: excludes reserved pseudo-addresses (pool_fee/prize_pool) and banned
    addresses; freeze-aware (skips while payouts frozen); DEFERS if there are no active
    recipients (never sweeps into the void — balances stay put, reclaimable).

SUB-THRESHOLD PAYOUT (below-min "email support to withdraw" flow):
  A below-min miner who wants to stop and withdraw emails support. Admin first verifies
  ownership — types the CLAIMED mining IP or rig password into
  /api/admin/dormancy/verify-owner → verifyOwnerProof() returns match/no-match ONLY
  (proofs are salted-scrypt hashes; nothing is revealed). Then TWO paths (the
  "Tor + hardened recorder" scope chosen 2026-07-22):

  PRIMARY — backend-initiated Tor send (/api/admin/dormancy/send-payout, freshAdmin):
    the pool sends it itself, through the SAME locked withdrawal flow a miner uses, via
    withdrawalScheduler.createWithdrawal(addr, amt, 'tor', {adminOverride:true}). The new
    `adminOverride` opt bypasses ONLY the min-withdrawal floor + the post-failure reversal
    cooldown; the freeze, the CAS balance lock, and the one-pending-per-address cap (the
    double-pay guard — a second send while one is pending is rejected 429) ALL still apply.
    Real network fee + kernel are captured by the scheduler and recorded automatically —
    no out-of-band step, no send-then-record window. Requires the miner's wallet listener
    reachable over Tor (scheduler declines + reverses the lock if not).
    withdrawal_events.triggered_by = 'admin_override'.

  FALLBACK — recorder (/api/admin/dormancy/manual-payout, freshAdmin): for a send the
    admin already made out-of-band (slatepack / wallet CLI). manualPayout() writes a
    CONFIRMED withdrawals row (method='manual') + a 'withdrawal' debit — SAME taxonomy as
    an automated payout, which keeps coverage correct AND makes
    reconciliation.auditWalletSends() MATCH the send instead of flagging false theft.
    Never raw-subtract a balance (breaks the integrity invariant). HARDENED against
    double-submit (review finding #1): dedup rejects a duplicate kernel_excess/slate_id
    (a unique on-chain id) or an identical (address, amount, method='manual') within 60s
    → {ok:false, duplicate_*}; the frontend also disables the button in-flight. Without
    this a resubmit would write a 2nd debit for one real send → over-debit + audit drift.

  SLATEPACK from the admin panel is deliberately NOT built as a broker UI — an interactive
  Mimblewimble tx is an unavoidable 2-message round-trip (there is no non-interactive
  slatepack send in Grin), so slatepack cases route through the recorder rather than
  pretending the panel makes them convenient.

CODE MAP:
  · lib/dormancy.js — DormancyManager: _candidates, listDormant (masked/unmasked),
    statusFor (account countdown), history, preview (dry-run), runOnce (the atomic sweep
    → single prize_pool credit; 6h scheduler + first pass 60s after boot), manualPayout.
    maskAddress = grin1qxy…mn4p. (_activeRecipients removed in the 2026-07-22b revision.)
  · lib/incentives.js — prizePoolStatement(recentLimit): lifetime in/out breakdown by
    source (fee_cut/donation/topup/dormant in; prize_award/jackpot/join_bonus/streak out)
    over the ledger-rollup horizon + balance + recent rows. Shared by admin + public.
  · db.js — dormancy_dispositions (one row/batch) + dormancy_disposed_sources (one
    row/swept address); never pruned → historical detail behind the public page after
    raw balance_log prunes at 60d.
  · pool-settings.js — payout.{dormancy_enabled(false), dormancy_months(24),
    dormancy_active_window_days(30), dormancy_policy_effective_at(0=auto)} + validators;
    ToS `terms` default gained "4. Abandoned and unclaimed balances" (existing pools
    must add the clause manually — pages are seeded once into the CMS `pages` table).
  · lib/withdrawal-scheduler.js — createWithdrawal() gained a 4th arg `opts`; opts.adminOverride
    bypasses only the min floor + reversal cooldown (all other guards intact) and stamps
    withdrawal_events.triggered_by='admin_override'.
  · index.js — GET /api/pool/unclaimed (public, masked: dormant list + disposition
    ledger); account `/api/account/:addr` gains a `dormancy` field; admin GET
    /api/admin/dormancy (status+preview+unmasked list+history, secureAdmin), POST
    /run + /manual-payout + /send-payout (freshAdmin) + /verify-owner (secureAdmin).
    /send-payout honours the freeze and maps createWithdrawal's numeric .code to HTTP status.
  · Frontend — payment-history.html: page-scoped notice banner (payout part only, NOT
    site-wide) + U-01 tiles / U-02 masked dormant list (+ "check your own account page"
    disambiguation) / U-03 redistribution ledger. account-settings.html: per-address
    dormancy notice (counting/eligible/disposed) + a sub-threshold "email support" note
    (#acct-subthreshold, shown only when 0<balance<min; reuses branding.js contact-link).
    admin payments.html: dormancy KPIs + "run now" + "Pay a below-minimum miner" (ownership
    verify → ⚡Send Tor payout now [primary] OR Record out-of-band send [fallback, button
    disabled in-flight]) + dormant list + history. settings-payout.html: config controls.
    [2026-10 payouts split: the KPIs, "run now", dormant list and history now live on
    admin dormant.html (Payouts → Dormant balances); "Pay a below-minimum miner" is the
    collapsed "Manual payout — support request" card on payments.html (Payouts → Queue),
    still calling /api/admin/dormancy/*. Implementation §10.14.]

STATUS: BUILT on `add-ons` 2026-07-22, node --check + integration smoke tests (temp DB:
disposition weights/remainder, reserved+banned exclusion, grandfather, over-balance reject;
below-min adminOverride locks funds + one-pending cap blocks a 2nd send; recorder dedup
rejects duplicate kernel/slate/recent, no double-debit — all verified). NOT YET VPS-tested.
