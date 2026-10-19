# Script 07 — Public Mining Pool (Design)

> **Covers code as of:** 2026-10-19 for §18.12 *Donor link* and the §18.4 / §18.5 lines beside it (written before the code; the rebuild paragraph, reason codes and gate order rewritten to the built behaviour after the second review; the name-change re-review paragraph corrected to the built behaviour after review; the name-route gate order and the state machine it mirrors were read in `routes/account.js` and `lib/donor-profiles.js` as committed in the working tree) · 2026-10-16 for the §8 *Slatepack security* signed-payment-proof paragraph · 2026-10-11 for the §20.5 *Services lamps* note (pool + wallet `up_days`, `payouts.frozen` — the uncommitted working tree that built them) · 2026-10-05 for the §7 fee bullets (fee floor, network-fee booking, operator revenue withdrawal — written against the uncommitted working tree that built them) · 2026-10-05 for §21 (shortened to the decisions + rules by the docs fold; the mechanism moved to `script07_implementation.md` §10.17, written against the Parts 1–3 + R code as committed in `45b6004`; Parts 1b and 4 are not built) · 2026-10-04 for §19.15 *Part C4*, the §19.14 C4 row, the §19.17.6 pointer, the §18 C4 note and the §18.11 C4 pointer (donor names auto-checked — the files named in *Part C4*; uncommitted, not VPS-tested) · 2026-10-03 for §20.1–§20.6 (Node availability — the DESIGN, written before any code, against `back-end-pool/lib/grin-node.js`, `lib/block-monitor.js`, `lib/alert-monitor.js`, `index.js` `buildPoolStatus` and the `grin-pool-manager` unit template as committed at `65d5061`. Parts 6–8 and the R2 fixes are built, uncommitted and never run; where they differ, the as-built record wins: the §20.5–§20.8 as-built notes moved to `script07_implementation.md` §10.15 on 2026-10-03) · 2026-10-03 for three line notes about the admin Payouts split (the §6 not-built list's `users.html` nav title **Security**, §8.1.4's status-list bullet, and the abandoned-balances CODE MAP note; written against the uncommitted payouts-split working tree, detail in impl §10.14) · 2026-09-27 for §8's "Why this is safe", "One send at a time", "Held resolves itself" and "The operator" bullets (the uncommitted /review-fix working tree), and for §15.5's "Response binding" bullet (the uncommitted binding-fix working tree) · 2026-09-26 for §6's four admin withdrawal / Tor-pause rows and §8's opening line, Tor row, no-auto-payout paragraph, balance-model table, the NEW "One Tor attempt, then an answer" section (which replaced "What moves a Tor payout on"), the pre-flight paragraph's two additions, and the §8.1 heading + status note (the uncommitted one-attempt Tor payout working tree) · 2026-09-25 for §6's `/withdraw/:id/slatepack` row (written with the code) · 2026-09-25 for §8's Tor-row note, the no-auto-payout paragraph, the two new paragraphs after the balance model, and the §8.1 heading + status note + §8.1.1 annotation (the uncommitted Tor-payout-hardening working tree, F1–F5 built); the body of §8.1 is the DESIGN as written that day against the Tor rail after F1–F4, before F5 was built — as-built deltas live in impl §10.8 · 2026-09-24 for §18.10 Parts 1–6 + §18.11 (per-share donation, the donor-profile backend, the admin review queue, the public wall and the account page, written against the uncommitted working tree) · 2026-09-23 for §4's effective-latency note, §11's gateway :443 note and §13.13 (hub move + connect-page latency, written against the uncommitted working tree) · 2026-09-07 for the multi-region surface (§2–§7, §11–§12, rewritten against the live code) · 2026-06-08 for the rest of the §6 endpoint table
> **Last verified:** §18.12: 2026-10-19, PARTIAL — by the session that fixed the review findings: the *Why a table rebuild* paragraph, validation step 6's re-parse rule, the reason-code list (statuses read in `DONOR_REFUSAL` in `routes/account.js` and in `routes/admin/donors.js`) and the gate order were read against `lib/db.js`, `lib/donor-profiles.js` and the two route files as edited that day. Earlier, 2026-10-18: a review session spot-checked the 200-char limit, schemes, the onion rule, userinfo/IP/localhost/TLD refusal, nostr, the rename rule and the read shapes against the code (each also asserted by `scripts/test-donor-link.js`). Not a line-by-line check of the whole section · §21: 2026-10-05, PARTIAL — by the docs-fold session: each remaining rule, constant and route list was read against the working tree (`lib/stratum-pause.js`, `lib/stratum-server.js`, `lib/pool-settings.js`, `index.js`); §21.12 was then annotated by the Part 4 build session (2026-10-05) against its own code + a local haproxy 2.8.16 run — not an independent check · §20: never systematically verified (the design was written before the code; its as-built notes, now in implementation §10.15, were written with the code, and a passing test suite verifies the code, not this text) · 2026-10-03, PARTIAL — **the three Payouts-split line notes only, by the docs-fold session**: the `users.html` NAV title, `STATUS` in `payments.html`, `PAYOUT_ACTIVE_STATUSES` in `payouts-common.js` and the dormancy/manual-payout placement were read in the working tree · Earlier: 2026-09-28, PARTIAL — **§19.14's Part 7 row, §19.15 *Part 7* and the §19.9 / §19.11 line edits only, by the Part 7 build session**: each delta read against `play/server/lib/{leaderboard,events,admin,badges}.js`, `lib/events/*`, `play/shell/js/play-boards.js` and `games-events.html` as written that session; games `npm test` 630/630 (NEW `test-events.js` 101), pool `npm test` 2301/2301 (`test-admin-panel.js` [13]), a one-shot headless-Edge probe 58/58 of the /play/ panel under the real shell CSP; `games-events.html` not opened in a browser; nothing run on a VPS. Before that: 2026-09-27, PARTIAL — **§19.14's Part 6 row and §19.15 *Part 6* only, by the Part 6 build session**: each delta read against `play/shell/**`, `play/games/chess/frame/**`, `public-shell.js` and `_pgs_stage_trees` as written that session; games `npm test` 519/519 (NEW `test-shell.js` 68, five mutations each turning it red), pool `npm test` 2290/2290, a one-shot headless-Edge probe 48/48 against the staged tree with the real nginx headers; nothing run on a VPS. The same session also REPAIRED this file: the Part 5 session's write of §19.15 *Part 5* #1 had expanded a literal `$` + backtick as a perl pre-match, pasting a second copy of lines 1–4377 mid-sentence (9 314 lines); the duplicate was checked byte-identical to the file's own prefix before it was cut, so nothing unique was lost. Before that: 2026-09-27, PARTIAL — **§19.14's Part 5 row and §19.15 *Part 5* only, by the Part 5 build session**: each delta read against `play/server/lib/{registry,matches,settings,app,http}.js` and `play/games/chess/` as written that session; games `npm test` 451/451 on Windows (NEW `test-matches.js` 133, with perft exact on five reference positions); nothing run on a VPS. Before that: 2026-09-27, PARTIAL — **§19.14's Part 4 row and §19.15 *Part 4* only, by the Part 4 build session**: each delta read against `play/server/lib/{pool-link,ratelimit,ledger,plays,sessions,auth,mode,settings}.js` and `app.js` as written that session; games `npm test` 318/318 on Windows, with four mutations each turning `test-auth.js` red; nothing run on a VPS. Before that: 2026-09-27, PARTIAL — **§19.12's *As built* note, §19.14's Part 3 row and §19.15 *Part 3* only, by the Part 3 build session**: each delta was read in `07_lib_pool_games.sh` and the hooks as written that session; `bash -n` on the pool script and the three touched libs; the nginx snippet heredoc rendered with the mainnet constants and read; the deploy staging run once against the checkout. Nothing ran on a VPS. Same day, PARTIAL — **§19.3's common-rules bullet and settings note, §19.11's fast-write table, §19.14's Part 2 row and §19.15 *Part 2* only, by the Part 2 build session**: each statement was checked against `lib/games-link.js`, `lib/pool-settings.js`, `lib/config.js` and the `index.js` mount lines as written that session; the activity plan was run with `EXPLAIN QUERY PLAN` on the real schema, with and without the `INDEXED BY` pin; pool `npm test` exit 0, 2282 passed / 0 failed. Nothing was run against a live pool or on a VPS. Same day, PARTIAL — **§19.14's Part 1 row and §19.15 *Part 1* only, by the Part 1 build session**: each delta was read in the code it describes; the games `npm test` passed 155/155 on Windows (the 0600 mode and SIGTERM checks are POSIX-only and were skipped); §19.4's SQL block was compared with the v1 migration mechanically by that suite (35 objects), and that comparison was mutation-checked to fail on a changed default, CHECK or partial index. Nothing was run on a VPS. Same day, PARTIAL — **§15.5's "Response binding" bullet only, by the session that made the binding fix**: both finalize paths read in `lib/withdrawal-scheduler.js` after the edit; `npm test` exit 0 (impl §10.10 *Slatepack finalize binding*) · Same day, PARTIAL — **the four §8 bullets listed under *Covers code as of* for that date only, by the session that made the /review fixes**: each rule read in `lib/withdrawal-scheduler.js` and `lib/wallet-tor.js` after the edit; the grin-wallet v5.5.0 behaviour behind them (the CLI's coin selection and late lock, `tx_slate_state` never updated on the sender, `cancel_tx` needing a node) read in the upstream source that session; `npm test` exit 0 (impl §10.10 *Review fixes*) · 2026-09-26, PARTIAL — **the 2026-09-26 §6 / §8 / §8.1 edits listed under *Covers code as of* only, by the one-attempt docs-fold session**: the outcomes, the Held two-read rule and 24 h alert, the forced-refund refusals, the post-failure probe codes, the pause constants and its place before the probe, the Tor-only cooldown exemption, the `walletBin` fix and the deleted stepwise settings were read in the working tree (`lib/withdrawal-scheduler.js`, `index.js`, `lib/wallet-tor.js`); the offer's hide rules were grepped in `account-settings.html`, not re-run; `npm test` exit 0 (21 suites, 1900). The lock-before-broadcast fact comes from the Session 4 review's v5.5.0 source read and was **not re-checked**. The four rejection reasons are the operator's, recorded as given. 2026-09-25, PARTIAL — **§8's four edits listed under *Covers code as of* only, by the Tor-payout-hardening docs-fold session**: `SHORTFALL_RETRY_S`/`TOR_DOWN_RETRY_S` and both caps, `UNMINED_ALERT_S`, the repost limits, the `confirmed`-only kernel backfill, the `payout_unmined` levels and the settings removal read in the working tree; the "kernel written at lock, rewritten at finalize" fact is the F1 build session's source read, not re-checked. Same day, PARTIAL — **§8.1 only, by the F5 design session**: every grin-wallet claim was read in the v5.5.0 and v5.4.1 source (both tags cloned; file + function cited in place), and every pool claim was read in the working tree. §8.1.1's "exits 0 on a failed Tor delivery" comes from the source, not from running the binary; no test ran and nothing was built. The rest of §8 was not re-checked, and its "Auto-payout" paragraph is known stale (F4 deleted the keys; Part 7 of that plan folds it) · 2026-09-24, PARTIAL — **§18.9 → §18.11 *Part 6* only, by the §18 Part 6 review session (cold, separate from the builders)**: each §18.9 point answered against the code diff, not the build notes — the greps, a stub-DB distribution + `computeReconciliation` run, a 60,043-input banner-parser fuzz and the public-route inventory are that session's own; `npm test` 1343/1343 before the fix and 1345/1345 after. The 390 px probe claims of Parts 4–5 were **not** re-run. Same day, PARTIAL — **§18.10 Part 5 row + §18.11 *Part 5* only, by the §18 Part 5 build session**: each delta read in the code it describes; `npm test` 1343/1343; the panel's states and layout measured with a one-shot 390 px headless-Edge probe (four fixtures, both themes) · Same day, PARTIAL — **§18.10 Part 4 row + §18.11 *Part 4* only, by the §18 Part 4 build session**: each delta read in the code it describes; `npm test` 1331/1331; the page's layout claims measured with a one-shot 390/1280 px headless-Edge probe in both themes. Same day, PARTIAL — **§18.10 Part 3 row + §18.11 *Part 3* only, by the §18 Part 3 build session**: each delta read in the code it describes; `npm test` 1310/1310; the cookie attributes behind delta 1 read in `index.js`; the admin CSP line checked to be byte-identical to before the build. Same day, PARTIAL — **§18.10 Part 2 row + §18.11 *Part 2* only, by the §18 Part 2 build session**: each delta read in the code it describes; `npm test` 1298/1298; the multer boundary measured with a one-shot fake-stream run; §18.4's "no deploy-script change" claim grepped in the pool script. Same day, PARTIAL — **§18.10 Part 1 row + §18.11 *Part 1* only, by the §18 Part 1 build session**: each delta read in the code it describes; `npm test` 1145/1145. The rest of §18 is design, not a claim about code. 2026-09-23, PARTIAL — **§13.13's dark-gate / restored-pool bullets and §13.13.6 only, by the Part 9 review session**, read against the code it changed. Also 2026-09-23, PARTIAL — **§13.13 (hub move + latency), by the fold session only**: the names, keys and menu keys it cites grepped in the code (`B → 6/7` dispatch in `07_lib_pool_backup.sh`, the `pmg_*` function list, `probe_host`/`probe_enabled`/`grin-gateway-probe`/`maxconn 2000` in `07_lib_gateway.sh`, `latency_probe_domain`/`latency_hub_url`/the page `connect-src` in the pool script, `SEED_VERSION = 3` and the `_state`/`local_region` stamp in `lib/db.js`, `payout_control.before` in the manifest), the suggest route read in full in `index.js` (privacy + cache claims) and the header + `pickRecommended` of `lib/connect-suggest.js`; `npm test` re-run that session, 1133/1133 across 19 suites. **Taken from the seven build sessions' own reports, not re-checked:** the step order inside Migrate OUT/IN, the harness counts, the nginx/haproxy runtime measurements (incl. the 40-request `limit_req` figure), the Globalping numbers and the downtime estimate. Also 2026-09-23, PARTIAL — **§8's new Tor pre-flight paragraph only**, read against `lib/wallet-tor.js` (`REASONS`, `classifyProbeError`, `probeToronlineStatus`) and the `index.js` withdraw-route gate (null → allow + warn, false → 409, runs before `createWithdrawal`). The rest of §8 was not re-checked. Also 2026-09-23, PARTIAL — **§17 (all of it), by the Part 4 review**: every §17.2 decision and §17.4 threat note read against `lib/owner-proof.js` in full, the `miner_proofs` readers in `index.js` and `lib/db.js`, `requireBothProofs` + every `verifyOwnerProof` call site, the startup order, the two work guards in `lib/stratum-server.js`, `scripts/test-owner-gate.js` and the page's two renderers; KDF counts measured by a scratch harness, not reasoned. Three places were WRONG and are annotated in place (§17.2 #2/#3/#9, §17.4) with §17.7 holding the detail. Earlier the same day: **§17.6's Part 3 entry only**, read against the code that session: `migratePagesFromConfig` in `lib/db.js` (seed-once marker) and the `/restore` route in `index.js`. Before that: 2026-09-07, PARTIAL — **the multi-region surface only**, read against the code: the mode selector + `pool_mode_conflict_check` in `scripts/07_grin_mining_public_pool.sh`, `role`/`region`/`region_ports` in `back-end-pool/lib/config.js`, listener-port region stamping in `lib/stratum-server.js`, `shares.region` + `pool_locations` + `pool_region_metrics_hourly` in `lib/db.js`, the ingestion/health/region routes in `index.js`, and the WireGuard + region-port derivation in `scripts/lib/07_lib_gwctl.sh`. Everything outside that surface — the rest of §6, and §7–§10, §13–§15 — still rests on the 2026-06-08 pass (account + payout routes re-verified 2026-07-13) and was **not** re-checked, with one line-scoped exception: the admin-surface note in the §6 not-built list was corrected 2026-09-07 against `back-end-pool/admin-panel/` and `admin-shell.js`
> **Product code last changed:** 2026-10-19 (donor link §18.12 — built 2026-10-18, second-review fixes 2026-10-19; uncommitted, not VPS-tested; as-built in `script07_implementation.md` §10.6) · 2026-10-16 (slatepack rail requests a signed payment proof: `lib/wallet.js` `initSendTx`, `lib/withdrawal-scheduler.js` `PROOF_METHODS` + backfill, admin `payments.js` 🧾, account P-08 Method · Status merged) · 2026-10-11 (homepage Services lamps: NEW `lib/service-uptime.js`, `routes/pool.js` `/api/pool/status`, `lib/alert-monitor.js`, `reactor-dashboard.js`) · 2026-10-05 (fees: `MIN_WITHDRAWAL_FEE` 0.04, `network_fee` booking, operator revenue withdrawal + `/api/admin/revenue*`, account-page fee columns, admin Manual payouts panel — `withdrawal-scheduler.js`, `reconciliation.js`, `index.js`, `db.js`, `config.js`, `pool-settings.js`, `alert-monitor.js`, `hashrate-tracker.js`, `payments.html`, `account-settings.html`; uncommitted) · Same day (§21 Part 4, gateway hub health check — `07_lib_gateway.sh`, `test-proxy-v2.js`; uncommitted) · Same day (§21 Part 1b, restore / Migrate IN boot paused — `07_lib_pool_backup.sh`, `07_lib_pool_migrate.sh`, two admin-panel files; uncommitted). Before that 2026-10-04 (§21 Part 3, stratum pause admin UI: `admin-panel/admin-shell.js` strip + `window.AdminStratum`, `settings-announcements.html` Stratum section + two overlay-text fields, `health.html` intake line, `styles.css`; uncommitted) · 2026-10-04 (§21 Part 2, stratum pause admin API + public surface: `index.js` six `/api/admin/stratum/*` routes, pairing `stratum_bind_deferred`, `stratum` on branding / `/api/pool/stats` / `/api/health`; `lib/stratum-pause.js` request parsing + `publicStatus()`; `lib/pool-settings.js` computed overlay, `notices.stratum_pause_title`/`_message`, synthetic banner; `public_html/js/branding.js` the overlay's UTC resume line; `admin-panel/regions.html` the deferred-bind note; NEW `scripts/test-stratum-pause-api.js`; uncommitted, not VPS-tested) · before it, 2026-10-04 (§21 Part 1, stratum pause backend core: NEW `lib/stratum-pause.js`; `lib/stratum-server.js` pause/resume mechanism + in-flight tracking; `lib/db.js` `stratum_control`; `index.js` boot order; `lib/alert-monitor.js` two alert types; NEW `scripts/test-stratum-pause.js`; uncommitted, not VPS-tested) · 2026-10-03 (§20 R2 review fixes: `lib/node-availability.js`, `admin-panel/node-availability.html`, `scripts/test-node-availability.js`, `scripts/test-admin-panel.js`; uncommitted, not VPS-tested) · 2026-10-03 (§20 Part 8 homepage lamp: `fmtUpDays` + the `an-node` uptime row and hover in `public_html/js/reactor-dashboard.js`, `.lamp-up` in `reactor.css`, the `/api/pool/status` API reference row in `index.js`, test section [6]; uncommitted, not VPS-tested) · 2026-10-03 (§20 Part 7 admin page: NEW `admin-panel/node-availability.html` + its Dashboard nav row; uncommitted, not VPS-tested) · 2026-10-03 (§20 Part 6 node availability backend: NEW `lib/node-availability.js` + its test, `node_events` / `node_availability_meta` tables, the `auth` transport tag, `up_days` on `/api/pool/status`, two admin routes; uncommitted, not VPS-tested — implementation §10.15) · 2026-10-03 (admin Payouts split: `payments.html` → Queue, NEW `treasury.html` / `dormant.html` / `payouts-common.js`, payout request audit → `users.html` "Security"; front end only, uncommitted; reviewed 2026-10-03, its 4 low findings fixed the same day; not VPS-tested — impl §10.14) · Same day (§19 Part 3: the operator side — NEW `scripts/lib/07_lib_pool_games.sh` (menu `P`), the vhost's `/internal/` 404 + games glob include, games deploy in `9)`, games VACUUM in `C)`, cleanup group 1b/1c in the pool script; the games DB snapshot + separate restore in `07_lib_pool_backup.sh` / `07_lib_pool_migrate.sh`; impl §10.13 *Operator side*; **uncommitted, not VPS-tested**) · Same day (§19 Part 2: the pool link — NEW `back-end-pool/lib/games-link.js` (three `/internal/games/*` routes, the `/api/admin/games/*` proxy, the 60 s probe), the `games` settings section, `games_port` / `games_link_secret_file` config defaults, `index.js` mount lines + the `games` step-up section + the branding `games` flag, the hidden Play nav item, NEW `admin-panel/settings-games.html`, NEW `scripts/test-games-link.js`; impl §10.13; **uncommitted, not VPS-tested**) · Same day (§15.5 Slatepack finalize binding: both finalize paths fail closed when the row or the reply has no slate id — scheduler only; impl §10.10 *Slatepack finalize binding*; **uncommitted, not VPS-tested**) · Same day (§8 /review fixes #1–#6 — Held refunds wait for a resume and an intact wallet history, the Tor send holds the wallet send lock, grin-wallet's stdout reaches the settlement, the forced refund reads `tx_slate_state`, the send audit compares NET, a 360 s send timeout — scheduler, `lib/wallet-tor.js`, `lib/wallet.js` comment, `lib/reconciliation.js`, `index.js` audit row, admin `payments.html`; impl §10.10 *Review fixes*; **uncommitted, not VPS-tested**) · 2026-09-26 (§8 Tor payouts: one attempt, Held, Tor pause, Slatepack offer; stepwise F5 and the retry ladder deleted; the `walletBin` fix for mainnet payout #10 — scheduler, `lib/wallet-tor.js`, `lib/wallet.js`, `lib/db.js`, settings, `lib/alert-monitor.js`, `lib/reconciliation.js`, `index.js`, the account page, four admin pages; impl §10.10; **uncommitted, not VPS-tested**) · 2026-09-25 (slatepack rail: stored encrypted S1 + the §6 re-fetch route, refund-before-cancel expiry, `slate_cancel_pending` retry — security audit roll-up note "Slatepack rail: a lost tab…"; **uncommitted, not VPS-tested**) · Same day (§8 / §8.1 Tor payout hardening F1–F5 + the CLI rail's exit-0 fallback fix — scheduler, `lib/wallet.js`, `lib/wallet-tor.js`, `lib/db.js`, settings, `index.js`, three admin pages; impl §10.8; **uncommitted, not VPS-tested**) · 2026-09-24 (§13.13 hub move, review P1 — Migrate OUT removes the weekly VACUUM cron and refuses while a vacuum runs; `07_lib_pool_migrate.sh`) · Same day (§18 Part 6 review fix R6-1 — `index.js` `requireBothProofs` refuses a proof verified as the other kind with `wrong_kind` instead of the verifier's success code `match`; the account page's `DP_REASONS` key follows; suite 1343 → 1345; **uncommitted, not VPS-tested**) · Same day (§18 Part 5 — account page: P-05 donation row from `donation`, P-03 per-rig badge, NEW P-09 Donor profile panel in `account-settings.html`; the v1 aliases `donation_percent` / `donor_name` / `donor_name_state` dropped from `/api/account/:addr` and its api-docs row; suite 1331 → 1343; **uncommitted, not VPS-tested**) · Same day (§18 Part 4 — `/api/pool/donors` v3: card `banner` under the Top-N slot rule, `ranking.banner_slots`, `current_percent` dropped; `donate.html` D-01 rewrite, D-01b, D-03 spotlight; api-docs row; suite 1310 → 1331; **uncommitted, not VPS-tested**) · Same day (§18 Part 3 — admin review queue, image route, approve/reject/remove/block/unblock, `donors.html` rewrite, v1 censor/rescan/marker removed, wall + account names from approved profiles only, banner previews from a plain same-origin `src` (admin CSP unchanged); suite 1298 → 1310; **uncommitted, not VPS-tested**) · Same day (§18 Part 2 — `donor_requests` + `donor_blocks`, NEW `lib/donor-profiles.js`, `leagueRank()`, `donor_banner_slots`, `requireBothProofs` purpose wording, three `/api/account/:addr/donor-profile` routes + account `donor_profile` in `index.js`; suite 1145 → 1298; **uncommitted, not VPS-tested**) · Same day (§18 Part 1 — per-share donation in `lib/rewards.js` + `lib/incentives.js`, stored-% machinery removed, `liveDonations()` in `lib/donor-ledger.js`, additive fields on four `index.js` routes; suite 1134 → 1145; **uncommitted, not VPS-tested**) · 2026-09-23 (Part 9 review fixes C1–C6 — dark gate, unit disabled across Migrate IN, code never archived/extracted, freeze on a failed extraction, no archive without pool.db, midnight-safe OUT; `07_lib_pool_migrate.sh`, `07_lib_pool_backup.sh`) · Same day (hub move + connect-page latency, §13.13 — seeds v3 + local-region stamp in `lib/db.js`; NEW `lib/region-rtt.js`, `lib/connect-suggest.js`, `lib/latency-probe.js`; `/api/pool/connect/suggest`, `hub_rtt_ms`/`is_hub`, `connection.latency` on branding in `index.js`; `reactor-dashboard.js` + `reactor.css` measurement; gateway re-resolve timer + `6) Latency probe` in `07_lib_gateway.sh`; NEW `07_lib_pool_migrate.sh` + shared freeze/archive/restore cores in `07_lib_pool_backup.sh`; hub `/ping` + CSP in the pool script; suite 960 → 1133, 16 → 19 suites; **uncommitted, not VPS-tested**) · Same day (payout-rails fix — `lib/wallet.js` `create_slatepack_message` named params; Tor probe ported from 06d in `lib/wallet-tor.js` + new `lib/socks5.js`, 8 s default, `?fresh=1` on tor-check; P-04 slimmed and the §17.2 #8 fold removed; suite 881 → 945; impl §10.5; **not VPS-tested**) · Same day (§17 Part 4 review — `index.js`: `migrateProofSet` moved ahead of `stratumServer.start()`, `proof_too_recent`/`anchor_not_accepted_here` texts; `lib/owner-proof.js`: racing duplicate capture no longer evicts a second proof, a returning evicted anchor restarts `first_seen_at`; `test-owner-gate.js` 36 → 42, suite 875 → 881; **not VPS-tested**, §17.7) · Same day (§17 Part 3 — copy sweep, no logic: the homepage setup guide, the shipped Terms/Privacy/FAQ defaults in `lib/pool-settings.js`, the `anchor_not_accepted_here` error text + two `index.js` doc/comment sites, and stratum/owner-proof/db comments restated for a set of ten; suite unchanged at 875/875; §17.6 Part 3) · 2026-09-22 (§17 Part 2 built — the account page: `public_html/account-settings.html` renders `proofs` as counts, drops the "Evidence changed" banner, warns only past the cap and restates the gate copy for a set of ten; **not VPS-tested**, impl §10.4 "Account page", §17.6 records the deltas) · Same day (§17 Part 1 built — the ownership-proof SET backend: `miner_proofs` + `miner_accounts.proof_salt`, per-address scrypt salt, set capture/verify with LRU eviction and a flagged-not-deleted anchor, `migrateProofSet()` replacing `migrateOwnerProofHashes` and `backfillProofAnchors`, `proofs` on the account and admin miner views, suite 849 → 875; **not VPS-tested**, impl §10.4, §17.6 records the deltas) · 2026-09-21 (§16 Part 5 review: two fixes in `lib/donor-names.js` — the rescan parses the list once per walk, not per name, and a separators-only label is no label — §16.12; the same day Parts 1–4 were built in order: login grammar → storage + capture + account view → admin moderation → the public league, impl §10.3 "Part 1"–"Part 4", every part **not VPS-tested**; earlier the same day: `/api/pool/donors` totals over every donor + `active_donors` from live tags, account `is_online` per rig — impl §10.3) · 2026-09-20: pairing string carries the public port; gateway Status boot line, §13.12s; anchored ufw test + unmanaged-firewall readout, §13.12t — `scripts/07_grin_mining_*.sh`, `scripts/lib/07_lib_*.sh`, `web/07_mining_pool_public/`
> Prose last edited 2026-10-18 (NEW §18.12 Donor link — design only; the §18.5 "links are never made clickable" line, the §18.4 CHECK note and the §18 status line) · 2026-10-12 (re-sectioned by subject, § numbers kept as IDs; §19 → `script07_design_games.md`; solo appendix → `script07_reference_solo_flowchart.md`; build records §13.6b–13.7, §15.5, §16.11–16.12, §17.6–17.7, §18.10–18.11 → `script07_implementation.md`; dated status in headings → **Status:** lines. A re-section, not a verification) · 2026-10-11 (§20.5 *Services lamps*) · 2026-10-05 (§7: fee floor, network-fee booking, operator revenue withdrawal) · 2026-10-05 (§21 heading: Parts 1b + 4 built and re-reviewed) · 2026-10-05 (§21.13 Q1 marked built) · 2026-10-05 (§21 shortened to decisions + rules; as-built moved to impl §10.17) · 2026-10-04 (§21 Stratum pause added — design only, no code; operator answers to Q1–Q7 recorded in §21.13 the same day, all as recommended) · 2026-10-04 (§19 v2 Part C4: §19.15 *Part C4*, the §19.14 C4 row, the §19 / §19.17 headings, the §19.17.6 pointer, the §18 note and the §18.11 pointer; before it, Part C3: §19.15 *Part C3*, the §19.14 C3 row, the §19.4 v4 SQL, §19.16's superseded note, §19.17.5's moderator route + schema-sketch pointers, the §19 and §19.17 headings) · 2026-10-03 (Part 9 docs fold: the §20.5–§20.8 as-built notes moved to implementation §10.15, pointers left in §20.5, §20.6 and a new §20.7–20.8 stub; header) · 2026-10-03 (§20 R2 review: NEW §20.8, the §20.7 state table rows `unobserved` + `info`) · 2026-10-03 (§20 Part 8 built: §20 heading, the §20.5 *Part 8 as built* note) · 2026-10-03 (§20 Part 6 built: §20 heading, NEW §20.7 as-built deltas) · 2026-10-03 (§20 Node availability added — design only, no code) · Same day (admin route catalog: `GET /api/admin/miners/:addr/workers` added — impl §10.12) · Same day (binding fix: §15.5's "Response binding" bullet says the bind fails closed) · Same day (/review fixes: §8's "Why this is safe" gains the wallet-history proviso, NEW "One send at a time" bullet, "Held resolves itself" and "The operator" amended) · 2026-09-26 (one-attempt Tor payout fold: §8's opening line, Tor row and no-auto-payout paragraph; the balance table gains Held; the ladder sentence and "What moves a Tor payout on" replaced by "One Tor attempt, then an answer" with the rejected auto-Slatepack alternative; two sentences on the pre-flight probe; §8.1 heading → DELETED + a new status note) · 2026-09-25 (Tor payout hardening fold: §8's Tor row, the stale Auto-payout paragraph replaced by "There is no auto-payout", NEW paragraphs on uncounted retries and "paid is not mined", §8.1 heading → BUILT behind the switch + a status note, §8.1.1's bug annotated as fixed on the CLI rail) · Earlier the same day (§8.1 added — step-by-step Tor send design, F5, NOT built; it also records that today's CLI rail marks an undelivered Tor send as paid) · 2026-09-24 (§18 Part 6 review: §18 heading, §18.10 Part 6 row, NEW §18.11 *Part 6*, Part 5 #10 annotated) · Same day (§18 Part 5 built: §18 heading, §18.10 Part 5 row, §18.11 *Part 5*) · Same day (§18 Part 4 built: §18 heading, §18.10 Part 4 row, §18.11 *Part 4*) · Same day (§18 Part 3 built: §18 heading, §18.10 Part 3 row, §18.11 *Part 3*) · Same day (§18 Part 2 built: §18 heading, §18.10 Part 2 row, §18.11 *Part 2*) · Same day (§18 Part 1 built: §18 heading, §18.10 Part 1 row, NEW §18.11 build deltas) · 2026-09-23 (§13.13 added — hub move + connect-page latency; §4 gained the effective-latency rule; §11 the gateway :443 probe note; §13.10b/c annotated where a hub IP change was said to need no gateway action) · Earlier the same day (§18 added — donations v2: per-share donation, reviewed donor profiles with nickname + top-5 banner; design only, NOT built; §16 marked superseded in part and its Part 6 replaced by §18.10 Part 7) · Earlier the same day (payout-rails fix: §8 gained the Tor pre-flight probe paragraph, replacing a "no TCP port-probe before send" claim that had been false since 2026-07-19; §17.2 #8 annotated where the operator reversed the fold placement) · Earlier the same day (§17.7 added — the Part 4 review's ten answers and three fixes; §17.2 #2/#3/#9, §17.3 and §17.4 annotated where the review found them wrong; §17.6 Part 4 done) · Earlier the same day (§17 intro + §17.6 — Part 3 done, with its three deltas, incl. that already-installed pools keep the old CMS page text; §6's slatepack note pointed at §17) · 2026-09-22 (§17.6 updated — Parts 1 (backend) and 2 (account page) are built, with each part's deltas from §17 recorded there; Parts 3–5 unrun. Earlier the same day: §17 added — ownership-proof SET of 10 per kind with a per-address salt, replacing the 2-slot window) · 2026-09-21 (§16 added — donor names + donor league; §16.11 tracks the build, Parts 1–5 done, Part 6 = VPS acceptance still owed; §16.12 records what building changed against the design and the Part 5 review's findings)

**Product:** `scripts/07_grin_mining_public_pool.sh` + web app under `web/07_mining_pool_public/`.
**Scope:** the complete public-pool design — architecture, deployment modes, multi-region
(Model C gateways), database, API, reward pipeline, payments, white-label, and UI/UX.

> **Companion docs:**
> [`script07_implementation.md`](script07_implementation.md) — deploy, runbook, status, troubleshooting ·
> [`script07_security_audit.md`](script07_security_audit.md) — vulnerabilities, hardening, fixes ·
> [`script07_design_games.md`](script07_design_games.md) — the `/play/` games platform (§19).
> The **solo** miner (`07_grin_mining_solo.sh`) is a separate product —
> see [`script07_reference_solo_flowchart.md`](script07_reference_solo_flowchart.md).
>
> This file absorbs the former `script07_multi_region_design.md` and the imported
> `script07_public_pool/` GRINIUM doc set (deleted 2026-06-08). Where those described the
> standalone **Grinium** repo (`web/back-end-pool/`, ports `3002/3416`), this doc uses the
> **toolkit** layout (`web/07_mining_pool_public/`, ports `3333/3416/8080`).

---

## Contents — by subject

Sections are grouped by subject. **Section numbers are permanent IDs**, not reading order: code
comments, memory and the other pool docs cite them (`design §13.13`), so a section keeps its
number wherever it sits.

| Subject | Sections |
|---|---|
| Overview | §1 |
| Architecture | §2 · §3 · §6 |
| Stratum & mining | §21 stratum pause |
| Rewards & fees | §7 |
| Payments | §8 · §15 Goblin / Nostr rail |
| Identity & ownership | §17 ownership-proof set |
| Incentives & donations | Incentives · §16 donor names · §18 donations v2 |
| Multi-region & hub move | §4 · §13 |
| Admin panel, white-label & UI | §9 · §10 |
| Data & retention | §5 · §14 |
| Node availability | §20 |
| Ports | §11 |
| Follow-ups | §12 |
| Moved out | §19 games → [`script07_design_games.md`](script07_design_games.md) · solo flowchart → [`script07_reference_solo_flowchart.md`](script07_reference_solo_flowchart.md) |

Build records (per-part status tables, implementation deltas, review answers) are not design and
live in [`script07_implementation.md`](script07_implementation.md); each section that had one keeps
a one-line pointer under its old number.

---

# Overview

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

# Architecture

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

### Not yet implemented (doc-vs-code check)
**Status:** as of the 2026-06-08 doc-vs-code check; later edits are dated inline.
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

# Stratum & mining

## 21. Stratum pause — admin-controlled stop/start of miner intake

**Status:** built 2026-10-04/05 and cold-reviewed, not VPS-tested. As built: `script07_implementation.md` §10.17.

An operator switch that makes the pool **stop accepting miners**, on the public `stratum_port`
(`:3333`) and on every per-region internal listener (`3391+` / `13391+`). During a risky window
(a restore, a hub move, DB trouble), no share is then accepted that the pool cannot credit. Miners
fail over to their backup pool and come back on resume.

This section keeps the **decisions and rules**: the contract the code cites by number. The
mechanism as built (sequences, response shapes, routes, UI, failure table, tests, review) was
folded into `script07_implementation.md` **§10.17** on 2026-10-05. The pre-code version of each
subsection, with its line citations into the 2026-10-04 tree, is in git history. The build was
split into sessions; the plan was kept outside the repo.

### 21.0 Fixed decisions (operator, 2026-10-04)

1. **Separate from Maintenance Mode.** Maintenance Mode stays a website-only overlay. The
   coupling is **one-way**: a stratum pause turns the overlay on, and the website overlay never
   pauses stratum.
2. **In-process, not firewall.** The pool's stratum is our own Node code (`lib/stratum-server.js`).
   Solo needed the iptables gate (`scripts/lib/07_solo_quiet.sh`) because grin's built-in stratum
   offers no hook. In-process lets us settle in-flight shares first, gives miners a fast RST
   instead of a DROP timeout, and needs no root from the de-rooted service (§13.9).
3. **Refuse, never accept-and-drop.** A paused pool closes its listeners and its sockets. It never
   acks a share it will not credit.
4. **No recurring daily schedule.** Solo's quiet hours exist for the miner's own power bill; on a
   public pool a daily pause sends miners to a competitor every day. Instead: a manual pause with a
   **mandatory auto-resume**, plus an optional **one-off planned window** (UTC).
5. **State survives a restart** (solo's `enforce` idea): stored in the DB, re-derived at boot.
6. **UX:** an own section directly **below "Maintenance Mode"** on `settings-announcements.html`,
   with its own buttons, never part of that page's form-wide Save; a red strip on every admin
   page; a status line on `health.html`.
7. **Gateways need no change** for the pause to work (§21.12). The gateway check makes the edge refuse at once.

Borrowed from solo: the *ideas* only (re-derive at boot, log every action, a live-state feed).
Not borrowed: the firewall, cron, and the local-time window (a public pool is UTC, memory
`feedback_pool_utc_display`).

### 21.1 Where the state lives — a single-row table, not a setting

**Not a `pool_config` key.** The section Save, the section restore and `resetAll` all write that
table wholesale, and none of them may ever flip intake. The state is the single-row
`stratum_control` (`CHECK (id = 1)`, beside its precedent `payout_control`). A missing row means
accepting. All times are unix seconds rendered as UTC, and `until` is never NULL while paused.
`reason` is admin-only and never published. **Ownership:** `lib/stratum-pause.js` owns the row and
all policy; `StratumServer` gets only the mechanism. DDL and column meanings → impl §10.17 *State*.

### 21.2 Pause sequence

The order is the rule, each step placed so a crash after it is safe:

1. One transition at a time; a second request → 409 with the current state.
2. **Persist first.** A failed write does NOT stop the pause (`persisted:false`).
3. Close **every** listener: public, region and hot-bound.
4. **Settle.** Stop reading, refuse any further submit/login with a real (uncounted) error, and
   wait for every in-flight submit, bounded at **30 s** (Q6). Past the bound nothing is abandoned:
   **a block candidate in flight is still recorded after its miner's socket is gone.**
5. Destroy the remaining sockets.
6. Invalidate the branding memo; audit.

The UI says "settled — safe to proceed" only when settled. → impl §10.17 *Pause*.

### 21.3 Resume sequence

Re-bind the public listener and every `config.region_ports` entry **as it is now**, and report
each port's real result. Go accepting **even if some binds failed**: the failures stay visible and
alert (§21.11). The same action while accepting re-binds only what is missing; it is the retry
button. → impl §10.17 *Resume, re-bind, hot-bind*.

### 21.4 Hot-bind during a pause

A region paired during a pause must **not** open a listener. Pairing has already written
`region_ports`, so resume binds it. The pairing response must say the listener is deferred, never
report it live. → impl §10.17.

### 21.5 Boot

The re-derive runs **before any bind**, so a paused pool never opens a port at a restart.

- Paused + future `until` → stay paused.
- Past `until` → resume (audited).
- A window that started while down and has not ended → convert it to a pause.
- A window that started and ended while down → drop it (audited).
- A row read that **throws fails closed**: paused for 2 h, critical log + alert.

There is no SIGTERM handler, so persist-first is what makes a restart mid-pause safe.
→ impl §10.17 *Boot*.

### 21.6 Timers — one tick, no cron, no long `setTimeout`

One idempotent `evaluate()` every 15 s, also run at boot. Not one `setTimeout` per deadline: Node
clamps a delay over 2³¹−1 ms (24.8 days) to **1 ms**, and a window may be 30 days ahead.

### 21.7 Limits (server-side; the UI is not the control)

| Limit | Value | Why |
|---|---|---|
| Manual pause | `duration_min` ∈ {15, 30, 60, 120}, `until ≤ now + 2 h` | A forgotten pause costs at most 2 h of every miner's revenue |
| Extend | a new `until` in (now, now + 2 h]; no lifetime cap, but **each extension is a step-up + audit row** | A long restore stays possible only as repeated human decisions |
| Planned window | 5 min – 6 h; start ≥ now + 15 min; start ≤ now + 30 days; one at a time | Unattended, so the larger cap; the lead lets the strip and banner be seen; the horizon bounds a year typo |
| `reason` | required, 3–300 chars, **never published** | Free text can carry internal detail |

A manual pause still running when a window starts merges with it: `until = max(until,
planned_end)`. Resume during a running window ends it. (Q2: as written.)

### 21.8 Maintenance coupling — computed, never written

The pause **never writes `notices.maintenance_mode`**. The overlay is computed when the public
payload is built:

- Operator flag ON → their text, unchanged by a pause.
- Flag OFF and paused → the stratum text (Q4: two editable `notices` keys with defaults) and the
  resume time.
- Neither → off.

So resume can never switch off an operator's overlay, nor leave one on they never set. Every
transition invalidates the branding memo. The balance page (`account-settings.html`) and login
stay exempt.

### 21.9 Public signal (UTC everywhere)

`/api/public/branding` and `/api/pool/stats` carry a `stratum` block: accepting, paused since,
resumes at, and the planned window. Times are ISO with `Z`, and **the reason is never included**.
While paused, and from **24 h before** a planned window (Q5), a synthetic non-dismissible banner is
added, so exempt pages show it too. `/api/health` stays `ok` (it reports HTTP) and gains `stratum`.
→ impl §10.17 *Public signal*.

### 21.10 Admin API

Six routes under `/api/admin/stratum/`: control, pause, extend, resume, window, and delete window.

- **Every mutation is step-up (`freshAdmin`), resume included** (Q3). The dangerous direction is
  the *early* resume: during a restore it acks shares into a DB about to be replaced. The
  precedent `payouts/resume` is step-up too.
- Window times are **zone-qualified ISO only**. A zone-less string is a 400, because it would be
  read as server-local time.
- Every state change writes an `admin_audit_log` row (`target_type 'stratum'`, never a miner
  address).

Routes, bodies, responses and audit action names → impl §10.17 *Admin API*.

### 21.11 Failure modes

The rules:

- A failed re-bind leaves intake **DEGRADED, not silent**: strip + Re-bind + a
  `stratum_bind_failed` critical alert.
- A crash at any point leaves the pool paused, never open.
- A DB that cannot be written still pauses (in memory, flagged).
- A DB that cannot be read boots paused.
- Two admins get a 409 with the current state, rather than acting on a stale page.
- While paused, the gateway health views read healthy (they see the tunnel, not intake), so the
  panel says so.

Payouts are untouched; they have their own kill-switch. Full table → impl §10.17 *Failure modes*.

### 21.12 Gateway behaviour, and the optional gateway check

**As is (no change).** The gateway is HAProxy `mode tcp`, `server central ${hub_ep}
send-proxy-v2`, one backend, no `check` (`07_lib_gateway.sh`, the haproxy heredoc). It forwards
bytes and **cannot ack a share**. While the hub is paused, the gateway still accepts the miner's
TCP connect and dials the hub's closed region port. It gets an RST, retries (default `retries 3`)
and closes the miner. Connected miners are cut when the hub destroys their sockets. A miner sees
"connected, then dropped" in a loop, and mainstream miner software fails over. Cost to the hub:
nothing.

**Gateway check: refuse at the edge (Q7: in scope).** **Status:** built 2026-10-05, not VPS-tested.
The as-built is implementation §10.17 *Gateway hub health check*. Since then the "As is" paragraph above describes
only a gateway that has not been re-rendered.

```
backend grin_central
    server central ${hub_ep} send-proxy-v2 check inter 5s fall 2 rise 2
frontend grin_stratum_in
    tcp-request connection reject if { nbsrv(grin_central) eq 0 }
```

- A miner is refused at once, at most ~10 s after a pause (2 × 5 s). After a resume the edge
  reopens within ~10 s (rise 2).
- **Plain `check`, not `check-send-proxy`.** A TCP connect is enough, and the hub's region
  listener tolerates a probe that sends nothing: `handleNewConnection` logs nothing on accept or
  close, the PROXY parser runs only on `data`, and `cleanup` is silent. So there is **no hub log
  line per probe.** *Re-confirmed at build, with one correction.* The probe is not silent:
  because the server line has `send-proxy-v2` and no `port`/`addr`, haproxy sends a 16-byte
  PROXY v2 **LOCAL** header before it closes (captured from haproxy 2.8.16). The hub parses that
  header as `ip: null` and still logs nothing, so the conclusion stands.
- **Cost:** one TCP connect per gateway every 5 s, negligible against a 25 000 socket ceiling.
  HAProxy logs only state changes, which also exposes a dead tunnel or hub.
- **Accepted side effect:** a WG blip over ~10 s makes the edge refuse new miners until the checks
  recover. Today those miners would be accepted and dropped anyway.
- The heredoc is unquoted, so it must carry no backticks.
- **Existing gateways pick this up only on a re-render.** Run the gateway's `2) Configure` and
  press Enter at every prompt. It rewrites `haproxy.cfg` and restarts the forwarder. The render
  now runs `haproxy -c` before it swaps the file in, and the gateway's `5) Status` shows a
  `Hub check` line.

### 21.13 Open questions for the operator — all answered 2026-10-04 (every recommendation accepted)

- **Q1. Boot paused after a restore / Migrate IN?** **YES.** A `pbk_pause_stratum`
  beside `pbk_freeze_payouts` in `07_lib_pool_backup.sh` writes `stratum_control` straight into
  the restored `pool.db` (`source='restore'`, `until = now + 2 h`). A restored pool then starts
  **not accepting** until the operator has checked it. **Built 2026-10-05** (impl §10.17 *Restore / Migrate IN boot paused*);
  Migrate IN re-stamps the pause right before it starts the service, so its 2 h run from the start.
- **Q2. Caps** as §21.7. **As written.**
- **Q3. Step-up on Resume?** **YES.**
- **Q4. Overlay text:** **two editable `notices` keys** (`stratum_pause_title` /
  `stratum_pause_message`) with defaults. Text cannot flip state, so they are safe on the form Save.
- **Q5. Public banner 24 h before a planned window?** **YES.**
- **Q6. Settle bound:** **30 s** (15 s node submit timeout + 10 s block-credit reads + 5 s).
- **Q7. The gateway check (§21.12) in scope?** **YES.**

# Rewards & fees

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
  rails**. **Never below 0.04** (operator decision 2026-10-05, `MIN_WITHDRAWAL_FEE` in `config.js`):
  the old "`0` = the pool absorbs it" is gone — a promotion runs at `pool_fee_percent` 0 instead —
  and the fee is a fixed price the operator sets by hand, never tracked to the chain. The
  `network_fee_cost` alert (warning) says when the average real fee of the last 20 miner payouts
  reaches it. Grin charges the **sender** a network fee by
  transaction *weight* — `(inputs + 21×outputs + 3×kernels) × 0.0005` — so a payout costs the
  pool ~0.023 GRIN whether it is 25 or 2500 GRIN. Left unrecovered that cost scales with payout
  *count* and eats ~9% of fee income at a 25 GRIN floor (~23% at 10). 0.04 covers even a
  ~10-input sweep (~0.0275). Invariants: `0.04 ≤ withdrawal_fee < min_withdrawal` and
  `min_withdrawal ≥ 1`. A stored value below 0.04 (pool.json's old dead `0.0`, a pre-floor DB row)
  is **raised** to 0.04 with a warning in `validateConfig` and `PoolSettings.applyToConfig` —
  never rejected, so an upgrade cannot stop a pool from starting. A fee ≥ `min_withdrawal`
  (lowering the floor alone can strand a stored fee above it) falls back to 0.04, which the
  `min_withdrawal ≥ 1` validator keeps payable.
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
    served but not rendered. It does show what the operator actually *withdrew*
    (`operator_withdrawn_all`, below).
  - **Miner-facing figure (2026-10-05):** the account page's Withdrawal history shows
    **`fee_charged`** ("Withdrawal fee") and **"You received"** (`amount − fee_charged`), only for
    paid rows (a pending row shows the fee it will take; a refunded one neither). It used to show
    `withdrawals.fee` — the pool's own ~0.02 chain cost — next to the 0.04 the request form quoted,
    which read as two contradicting fees. The miner CSV carries `withdrawal_fee,received` the same
    way; the real chain fee stays published per payout on the payments page.
- **Network fees are the pool fee's cost, booked at revenue withdrawal (2026-10-05).** The pool
  wallet pays every payout's real chain fee, but no ledger row ever debited it: `pool_fee` grew by
  the full 0.04 while ~0.023 of it was already spent, so its balance overstated what the operator
  owns by Σ fees — and reconciliation added that same Σ back to both coverage gaps, so draining the
  bucket would have left the wallet short of what miners are owed **with no alarm**. Now
  `withdrawals.fee_booked` records how much of each confirmed row's `fee` has been debited from
  `pool_fee` as a `'network_fee'` ledger row. Booking is **one batch, inside each operator revenue
  withdrawal** (`WithdrawalScheduler._bookNetworkFees`) — not per payout, so no rail needs its fee
  before confirm and no migration is needed (legacy `fee_booked = 0` → the first withdrawal books
  the whole history). Reconciliation adds back **only the unbooked** fees
  (`Σ(fee − fee_booked)` over confirmed rows); adding booked ones too would count them twice.
  *Available revenue* = `pool_fee.balance − unbooked`. The bucket may go negative (a promotion at
  0% on a pool that has collected little); that is the truth, and the revenue CAS then refuses.
- **Operator revenue withdrawal (2026-10-05).** The only way GRIN leaves `pool_fee` for the
  operator. It is a normal locked Tor payout (`createRevenueWithdrawal`) with three differences:
  `grin_address = 'pool_fee'` and the coins go to **`dest_address`**; no flat fee (it would be
  credited straight back); and its confirm debit is **`'operator_withdrawal'`**, never
  `'withdrawal'` — every reader of `debit/'withdrawal'` means "paid to miners". Rules, all in the
  admin routes (`/api/admin/revenue*`):
  - one saved address (`operator_revenue` table), never typed into the withdraw form; the page
    echoes the address it showed and a mismatch is refused;
  - changing it needs step-up, writes an audit row, raises a **critical**
    `operator_revenue_address_changed` alert (closed by the operator, "It was me"), and starts a
    **24 h hold** before any withdrawal may go to it — a stolen admin session can repoint but not
    drain in one sitting;
  - the address must carry this network's prefix (`grin1` / `tgrin1`);
  - one in flight at a time; honours the payout freeze.
  Reported **beside, never inside**, miner payouts: the reconciliation flow statement has its own
  `operator_withdrawals` line; `hashrate-tracker` excludes `grin_address = 'pool_fee'` from every
  payout figure and reports `totals.operator_withdrawn_all` / `operator_withdrawal_count`; the
  public payments feed lists the row as `operator: true` under the fixed label "Pool operator"
  (never the destination). For the operator's records, `GET /api/admin/export/operator-revenue.csv`
  gives one row per UTC day: fee income, prize diversions, network fees paid (by confirm day),
  net revenue, withdrawn.

---

# Payments

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
undecryptable blob. Encryption, not payment proof, is the anti-theft control. Tor needs neither
(listener is address-bound).
**Signed payment proof (dispute evidence, not anti-theft).** `init_send_tx` carries
`payment_proof_recipient_address` = the miner's grin address — the same key the S1 is encrypted to,
so the one wallet that can open the slate is the one that can sign. The miner's wallet signs on
`receive`; `finalize_tx` refuses a reply whose signature does not verify, so the row stays
`slatepack_pending` and the TTL refunds it. That refusal reaches the miner as a 400 with a plain
"your wallet did not sign the payment proof" instruction (`PROOF_UNSIGNED_RE`, matched on
grin-wallet's own `verify_slate_payment_proof` phrases), not the raw wallet error. Once confirmed, the proof is backfilled into
`withdrawals.payment_proof` exactly like a Tor payout's (🧾 in the admin payments page, *⬇ file* on
the account page). Slatepack payouts made before the rail requested proofs have none (the wallet
answers "does not contain a payment proof" → `''`). The Goblin rail still sends `null`: no proof.
Until it is stored the proof exists only in the sending wallet; once stored the wallet is never
asked again, so a wallet swap or seed recovery cannot take it. A row whose fetch fails is backed off
1 h (`payment_proof_retry_at`) so failing rows never fill the backfill's 20-row batch, and the
wallet answering "transaction doesn't exist" settles it to `''` only after 3 such answers spanning
24 h (`payment_proof_gone_count` / `_since`) — a transport error never counts.
**Status:** built, not VPS-tested.

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

### 8.1 Step-by-step Tor send — withdrawn

**Status:** built 2026-09-25, removed 2026-09-26, never ran on a VPS. Kept as design record; see the note below.

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

What step 5 means for the pool as it runs today. This design does not fix it; it was raised
as an open question for the build. *(Fixed 2026-09-25 on the CLI rail: only `Tx sent successfully`
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
| `receive_tx` written; the reply is missing, garbled, too large or late (`delivering`) | locked S1 | maybe a TxReceived + S2 | Cancel, then a counted retry. Sending the same S1 again cannot bring back a lost S2: the receiver refuses a second receive of that slate id (`TransactionAlreadyReceived`, `foreign.rs` `receive_tx`). A new receive would also create a different output. The money is safe because the miner cannot finalize. What the miner may see is an incoming tx that never confirms (open question 3 of the build). |
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

## 15. Goblin nickname payouts over Nostr

**Status:** designed 2026-07-17; built 2026-07-18, off by default (§15.6), not VPS-tested. What the build changed against §15.3 → §15.5 (in the implementation doc).

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

### 15.5 What shipped vs the sketch → `script07_implementation.md`

Moved to *Design §15.5* (Payments) in [`script07_implementation.md`](script07_implementation.md).
It records the deliberate deviations from the §15.3 sketch — read it before trusting the sketch.

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

# Identity & ownership

## 17. Ownership-proof SET — 10 per kind, per-address salt

**Status:** built 2026-09-22/23, independently reviewed 2026-09-23, not VPS-tested. Build status and review answers → §17.6–§17.7 (in the implementation doc).

Replaces the **2-slot proof window** (`last_ip`/`prev_ip`, `last_pass_hash`/`prev_pass_hash`)
that has gated every self-service money action since 2026-07-17 (impl §10; audit §E, §F, §J3).
Built in four steps — backend → account page → copy sweep + docs → independent review — with VPS
acceptance still owed. §17.6 carries each step's state: **the backend, the account page and the
copy sweep are built, and the independent review has run** — it fixed three defects, and §17.7
records them against this contract.
Already-installed pools still show the old window in their CMS pages until the
operator edits them (§17.6, copy-sweep delta 3). Nothing in this section has run on a VPS.

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
   *(Review, §17.7 #3: never moves on a LIVE row — an evicted anchor returning restarts it.)*
3. **One salt per address.** `miner_accounts.proof_salt` (16 random bytes, base64, minted on the
   address's first v2 hash with `UPDATE … WHERE proof_salt IS NULL` then re-read, so two rigs'
   first shares landing together share one salt). Rows store `v2$<hashB64>`; scrypt parameters
   unchanged (N=16384, r=8, p=1, keylen 32, 16 MB). **One scrypt per verify and per capture
   regardless of set size** *(Review, §17.7 #5: two for a non-canonical, password-shaped IP)*; digests compared with `crypto.timingSafeEqual`. Legacy
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
   listener, for the same reason *(Review, §17.7 #1: "where the backfill ran" was AFTER the
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
  *(The review measured this as under-stated on both terms — 1–2 v2 digests, and n_v1 counts both
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

### 17.6–17.7 Status, implementation deltas and review → `script07_implementation.md`

Moved to [`script07_implementation.md`](script07_implementation.md): the as-built parts to *Design §17.6* / *Design §17.7* (Identity & ownership), the status table and the review to *Build notes (raw)*.
The build and the independent review changed parts of §17.2–§17.4 — read §17.7 before trusting them.

# Incentives & donations

## Incentives (prize pool, bonuses, lottery)
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

## 16. Donor names + donor league

**Status:** built 2026-09-21 and reviewed the same day, not VPS-tested; superseded in part by §18 (see below).

> **⚠ Superseded in part by §18 (2026-09-23, design only).** The donation becomes per SHARE (no
> stored %, no ceremony), the worker label stops being a donor name, and names + banners move to a
> reviewed donor profile on the account page. The ranking (§16.6) and expiry survive. Read §18
> first; this section is the record of v1 and of what is still built today.

Operator idea, settled in discussion 2026-09-21 after the first live-miner test of the donate
tag: let a donor put a **brand name** on the public donor wall (`donate.html` D-03), make the
wall **competitive** (amount × loyalty), and keep every donor forever with **post-moderation**
from the admin panel rather than a review gate. Status per part → §16.11; what
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

### 16.11–16.12 Status, implementation deltas and review → `script07_implementation.md`

Moved to [`script07_implementation.md`](script07_implementation.md): the deltas to *Design §16.12* (Incentives & donations), the status table and the review to *Build notes (raw)*.
The build and the review changed §16.1–§16.10 in places — read §16.12 beside them.

## 18. Donations v2 — per-share donation + reviewed donor profiles

**Status:** §18.1–§18.11 built 2026-09-24 and independently reviewed the same day, not VPS-tested — acceptance runs on the live mainnet pool (operator decision 2026-09-24). §18.12 (donor link) built 2026-10-18 and independently reviewed, not VPS-tested.

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
as the record of v1**; where they disagree, §18 wins.

> **Since §19.17.6 (games v2, 2026-10-04) donor NAMES are no longer reviewed:** they are checked
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
| `/api/account/:addr` | `donation: { rigs_donating, rigs_online, pct_min, pct_max, workers }`; `donation_percent` kept = `pct_max` until the account page switches, then dropped |
| `/api/account/:addr/workers` | per worker `donate_percent` (from its name; null = untagged) |
| `/api/pool/donors` | per card `rigs_donating`, `pct_min`, `pct_max`; `totals.active_donors` = addresses with `rigs_donating > 0`; `current_percent` kept = `pct_max` until the public wall switches, then dropped |
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

- **Since §18.12** the `kind` CHECK also admits `'link'` and the table has a `url TEXT` column; the
  SQL above is the original shape.
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
or digit. **Case is kept** (brands are cased). Dots are allowed (a donor may name a domain); a
name is never itself a link — a clickable link is its own reviewed kind (§18.12). Anything else →
400 with the rule in the message.

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

### 18.10–18.11 Status and build deltas → `script07_implementation.md`

Moved to [`script07_implementation.md`](script07_implementation.md): the deltas to *Design §18.11* (Incentives & donations), the status table and the review to *Build notes (raw)*.
§18.11 records what the build changed against §18.2 / §18.3 and the review's answers to §18.9.

### 18.12 Donor link

**Status:** built and independently reviewed, review findings fixed — not VPS-tested. The name-change re-review re-issues a waiting link under a new id (stale admin approves fail). If the startup table rebuild failed, the `url` column is already in place (it is added first, on its own), so names, banners and the wall keep working, and a link submit gets `links_unavailable` (503) before any proof is spent.

A donor can attach ONE link to their profile, shown on their wall card. It is the third kind in
`donor_requests` (`name`, `banner`, `link`) and is **pre-moderated like a banner**: invisible until
an admin approves it. Names stay auto-checked (§19.17.6); a word list can check text but not where
a URL goes. This reverses §18.5's former rule that nothing on the wall is clickable — the reversal
is scoped to this one reviewed kind.

**Decisions (operator, 2026-10-18 — FINAL unless the operator reopens them)**

| # | Decision |
|---|---|
| 1 | Its own `kind = 'link'`, not a column on the banner request: a link and a banner are approved, replaced and removed independently. |
| 2 | Schemes: `https://` · `nostr:` (`npub1…` / `nprofile1…` only) · `http://` **only** when the host is a v3 `.onion`. Everything else is refused. |
| 3 | Shown on **every league card**, not only the banner slots (§18.7). Never on the past-donors strip. |
| 4 | **A name change sends a live link back to review** (below). |
| 5 | Names remain auto-checked; only banners and links are reviewed. |

**Data model.** `donor_requests.kind` admits `'link'`, and a `url TEXT` column holds the
**normalised** URL for `kind = 'link'` rows (NULL otherwise). The two partial unique indexes
(§18.4) already make it "one pending + one approved per (address, kind)". `name`, `image`, `file`
and the image columns are NULL on a link row.

- **Why a table rebuild:** SQLite cannot ALTER a CHECK constraint, and `kind IN ('name','banner')`
  is one. An existing DB is upgraded once at startup (`migrateDonorRequests` in `lib/db.js`):
  1. A missing `url` column is added FIRST, as its own `ALTER TABLE … ADD COLUMN` — every donor
     reader names it, so if the rebuild then fails the old table is still fully usable (the old
     CHECK alone refuses a link row → `links_unavailable`).
  2. If the CHECK predates `'link'` or the column was missing, then in ONE transaction: rename the
     OLD table away, create the real one from the same DDL text a fresh install runs, copy every row
     column-for-column **keeping `id`** (the AUTOINCREMENT sequence and every audit reference
     survive), drop the old one, recreate the three canonical indexes plus any extra index or
     trigger, and run `foreign_key_check` afterwards.
  The order is the reverse of the `blocks` precedent ("create `_new`, then rename it") **on
  purpose**: a RENAME rewrites the stored SQL to `CREATE TABLE "donor_requests"` (quoted), which
  would no longer match a fresh install's text; a test asserts fresh == migrated. Idempotent: with
  the new CHECK and the column present it does nothing; a failure rolls back and is retried at
  the next start.
- A column-only alternative (`url` on the banner row) was rejected: it couples two reviews and
  cannot express "link live, banner pending".

**Validation** (the server is the check; the page's hints are advice). Applied in this order to the
raw input, and the **stored form is the normalised one** — what the admin approves is what is shown:

1. Trim ASCII whitespace. Empty → refused. Longer than **200 chars** → refused.
2. Any whitespace or control character (including U+200B–U+200F, U+2028/9, U+202A–E, U+2060, U+FEFF)
   inside → refused. Backslashes → refused.
3. Parse with `new URL()`; a parse failure → refused. Scheme is taken from the parse (so `HTTPS:`
   is `https:`); the raw input must also begin with that scheme followed by `//` (web) or `nostr:`
   with no `//`. `//host`, `https:/x`, `javascript:`, `data:`, `file:`, `vbscript:`, `mailto:`,
   `ftp:` and every other scheme → refused.
4. `https:` → host required; **`http:` only if the host is a v3 onion** (`[a-z2-7]{56}.onion` whose version byte (0x03) and SHA3-256 checksum verify,
   exactly, no subdomain, no look-alike such as `<56>.onion.example.com`); plain `http://` to a
   clearnet host → refused. An `https:` `.onion` is accepted under the same host rule.
5. No userinfo (`user:pass@`) → refused. Any port is accepted.
6. The host is stored in its ASCII form as `new URL()` produces it, so a homoglyph or IDN host
   shows as `xn--…`; a host that fails to convert → refused. A single trailing dot is stripped
   (`example.com.` → `example.com`). Refused as `link_host`: IPv4 and IPv6 literals, `localhost`,
   single-label hosts, and a host without a plausible TLD (the last label at least two letters, or
   `xn--…`). The v3 `.onion` form of step 4 is the only exception to the TLD test. A URL whose
   serialised `href` does not itself re-parse (a Unicode label that already holds `xn--`) →
   refused as `link_host`; the stored form is then built as text, never through URL setters
   (on such a URL a setter aborts the Node process).
7. `nostr:` → the remainder (lowercased) must be `npub1` or `nprofile1` followed by bech32 data
   characters only, **with a valid bech32 checksum**; `npub1…` is exactly 63 characters;
   `note1…`, `nevent1…`, `naddr1…`, `nsec1…` and a bare hex key → refused. No `?` or `#`.
8. Stored value = the parsed `href` for web links **with the fragment and query removed**, the
   lowercased identifier for `nostr:`.

Reason codes (JSON `reason`, each with its own text). The validator: `link_empty` ·
`link_too_long` · `link_chars` · `link_scheme` · `link_host` · `link_userinfo` · `link_nostr`, all
400. `unchanged` (409): the same as the live value (before the proofs) or the pending one (after
them — see the gate order below). `links_unavailable` (503): the startup rebuild has not
succeeded, answered before the proofs. `conflict` (409): a concurrent write to the same profile.
Admin side: `bad_kind` (400, a `kind` outside name · banner · link), `not_pending` (409, the
request was already decided or re-issued by a rename — reload the queue), `invalid_link` (422, a
stored row that no longer passes these rules cannot be approved; reject it).

**State machine** (per address, kind `link`; each transition ONE transaction, admin transitions
write their `admin_audit_log` row inside it, as §18.4):

| Event | Effect |
|---|---|
| donor submits | → `pending`; an existing `pending` → `replaced`. A live link **stays live** until the new one is approved. |
| admin approves | → `approved`; the previous `approved` → `replaced`. No file side-effect. |
| admin rejects `{reason}` | → `rejected`; the reason is SHOWN to the donor (the account page is address-addressable — the admin UI says so beside the field). |
| donor **Withdraw** | drops the `pending` one → `withdrawn`. |
| donor **Remove from wall** | live → `removed`, immediate, no review; allowed with donations off and while blocked. |
| admin removes `{reason}` | live → `removed`, reason shown to the donor. |
| block | every pending link of the address → `withdrawn` (as §18.6). |
| **name change** | see below |

**Name change re-reviews a live link.** When `submitName` writes a new approved name (a first-ever
name included; an admin removal, a ban or the donor's own removal of the name does not count) for an
address that has a live link, then in the same transaction the live link row → `replaced` and a
**new `pending` row with the same URL** is inserted; a link already waiting is re-issued instead (its URL wins over the live
one — it is the donor's newest request), and so is a waiting link with no live one — always under a new id, so an approve of the card judged beside the old name fails `not_pending`. Without this a link approved under a harmless name would stay up under
"Official Grin Wallet". The cost to an honest donor is the time to the next admin pass, at most
once per 7 days (the name cooldown). The wall loses the link at once. There is no per-link cooldown:
every change goes through a human, replace-pending caps the queue at one item per address, and
`Block` is the abuse answer.

**Routes.**

| Route | Does |
|---|---|
| `POST /api/account/:addr/donor-profile/link` | `{ url, proof, password_proof }` → pending |
| `DELETE /api/account/:addr/donor-profile/:kind` | `kind` now `name` · `banner` · `link`; `{ which: 'pending'|'live', proofs }` |
| `GET /api/admin/donors/requests?status=pending&kind=link` | the queue for links |
| `POST …/requests/:id/approve` · `…/reject {reason}` | as §18.6, for link rows |
| `POST /api/admin/donors/:addr/remove {kind:'link', reason}` | removes a live link |

The miner POST uses the name route's gate order: donations off (503) → account (404) → `blocked`
(403) → `not_a_donor` (409) → `links_unavailable` (503) → the input's shape → `unchanged` vs the
**live** link → both proofs (`requireBothProofs`, purpose `donor_profile`) → `unchanged` vs the
**pending** link → the write. ⚠ The pending comparison must stay AFTER the proofs: the live link
is public (wall, account page), the pending URL never is, so "is this your pending URL?" answered
to anyone holding the address would be an oracle for it. Nothing before the proofs reads a word
list or the pending row. Audit via `auditOwnerProof` as
`donor_profile_submit` / `_withdraw` / `_remove` with `details.kind = 'link'`, the request id and
the host — not the full URL. `/api/admin/donors/requests/:id/image` answers 404 for a link row.
The admin pending count (nav badge) includes links.

**Account-page read shape.** `GET /api/account/:addr` → `donor_profile.link`:
`{ live: { url, host, kind } | null, state, pending_at, rejected, removed }`, `state` ∈ `shown` ·
`expired` · `none`, `rejected` / `removed` as for banners. **The pending URL is never returned**,
exactly as the pending image is not: the endpoint is public to anyone holding the address. After a
reload the donor sees "a link is waiting for review, submitted …" and one sentence saying why the
URL is not shown. The live link may be shown — it is public on the wall anyway. The P-09 panel
gains a third column "Link"; its heading reads "names checked at once · banners & links reviewed".

**Wall card.** Each league card gains `link: { url, host, kind: 'web'|'onion'|'nostr' } | null` —
approved and unexpired only (same donation-recency rule as name and banner, `publicProfiles`),
**re-validated by the validator above on read**, so a row written by an older build or by hand
never becomes a live `javascript:` href. The past strip never carries it. D-01b's copy reads
"names are checked, banners and links are reviewed".

**Rendering rules** (wall and account page):
- `href` is set as a DOM **property**, never assembled into `innerHTML`; no URL passes through
  `innerHTML` anywhere.
- The visible host text is printed beside the name; a `.onion` link is labelled "Tor", a `nostr:`
  link "Nostr".
- Web and `.onion` links: `target="_blank"` and `rel="nofollow ugc sponsored noopener noreferrer"`.
  A `nostr:` link gets the same `rel` and **no `target`** (it hands off to an app handler; a blank
  tab would sit empty behind it).
- No new CSP source and no preview fetch: the page never loads the target.

**Admin queue card** for a link shows the donor's **current live name** beside it (the pair is what
is judged), the stored URL in monospace with `overflow-wrap: anywhere`, and the host on its own
line, plus a **hint flag** when the host equals another donor's live link. No click-through
preview — the admin copies it. A live-links list with Remove sits beside
the queue.

**Leakage** (`test-public-leakage.js` §9 pins the routes that touch `donor_requests`; the new miner
route makes the pin fail ON PURPOSE and the pinned list is updated after review): no pending URL,
reject reason or decider id on `/api/pool/donors` or `/api/account/:addr`; `link` absent on the
past strip.

**Further decisions (operator, 2026-10-18 — FINAL unless reopened):**
1. A donor with **no name** may hold a link; the card reads "Donor #N" beside it, and the admin card
   shows "(no name)" beside the URL.
2. The re-review fires when the *displayed identity* changes: a first-ever name (none → X) counts.
   An admin removal of the name, a name ban that strips it, or the donor removing their own name
   does **not** — identity is taken away, nothing new is impersonated; setting a name again then
   counts as a first-ever name.
3. Host rules are in Validation step 6.
4. The `nostr:` bech32 checksum is verified (Validation step 7).
5. A `nostr:` link's visible text is the identifier shortened to its first 9 and last 4 characters
   (`npub1abcd…wxyz`).
6. Fragment and query are stripped from the stored URL (Validation step 8).
7. The admin queue flags a link whose host equals another donor's live link — a hint only, never a
   refusal, as "same as an approved donor" is for names (§18.6).

# Multi-region & hub move

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

## 13. Admin-panel gateway pairing

**Status:** built 2026-07-13 (designed the same day), not VPS-tested. What building changed → §13.6b (in the implementation doc).

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
  `scripts/lib/07_lib_pool_regions.sh` (the `WG_*` block and `pool_wg_setup_server`) does today (single source: the helper).

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
(`scripts/lib/07_lib_pool_install.sh` `pool_install`) — historical convenience, not a requirement. §13.9
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

### 13.6b–13.7 Implementation deltas and files changed → `script07_implementation.md`

Moved to *Design §13.6b* / *Design §13.7* (Multi-region & hub move) in [`script07_implementation.md`](script07_implementation.md).
§13.6b records what building changed against §13.1–§13.6 — read it before trusting them.

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

### 13.10 Operational scenarios & disaster recovery

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

### 13.12 Panel-side multi-region bootstrap + onboarding fixes

**Status:** built 2026-08-22, not VPS-tested.

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

### 13.13 Hub move (Migrate OUT / IN) + connect-page latency

**Status:** built 2026-09-23, adversarial review the same day (7 fixes), not VPS-tested. As built: `script07_implementation.md` §8.7.

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

# Admin panel, white-label & UI

## 9. White-label / branding / SEO

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

Incentives (prize pool, bonuses, lottery), once the last part of this section, are in the
*Incentives & donations* chapter.

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

# Data & retention

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

## 14. Data retention & ledger rollup

**Status:** built 2026-07-16, not VPS-tested.

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

# Node availability

## 20. Node availability — pool-side recording, recorder ingest, homepage `up_days`

**Status:** designed and built 2026-10-03, reviewed the same day, never run. As built: `script07_implementation.md` §10.15.

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
  kind of change a review must treat as HIGH.
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
- *The change:* the backend attaches the HTTP status to the error inside `_rpcCall` before
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

**Display** (P-02 `#an-node` lamp):

| `up_days` | Shown |
|---|---|
| `0` | `up <1 d` |
| 1–59 | `up N d` |
| 60 to below 730 | `up N mo` (`floor(days / 30.44)`) |
| 730 and above | `up N.N y` (`days / 365.25`, floored to one decimal) |
| `null` | no uptime text at all, never `up 0 d` |

**As built (2026-10-03, never run):** the uptime is its own `span.lamp-up` row under the peer
count, not an inline ` · up N d`, and the hover text says "at least N days". The detail and the
reasons are in `script07_implementation.md` §10.15 *Homepage lamp*.

**Services lamps (2026-10-11, built, not VPS-tested).** All four P-02 Services lamps now read three
rows: title / state / detail. The node was first; the other three follow it.

| Lamp | Row 2 | Row 3 | Source |
|---|---|---|---|
| Pool svc | `online` / `offline` | `up N d` | `pool.up_days`, counted from when the pool process started |
| Node sync | `N peers` | `up N d` | `node.up_days` (above) |
| Wallet | `unlocked` / `offline` | `up N d` | `wallet.up_days` |
| Payouts | `active` / `frozen` | `last 2.3h` / `none yet` | `payouts.frozen` + `/api/pool/payments` |

- *Same contract.* `pool.up_days` and `wallet.up_days` use the same `upDaysFrom` and the same
  display rule as the node. When the value is unknown, row 3 is left empty, never `up 0 d`.
  These three `up_days` values are the only uptime fields in any public response.
- *The wallet clock* (`lib/service-uptime.js` `ReachableSince`) has two observers: AlertMonitor's
  wallet check and the status builder. It follows three rules:
  - A failure must happen twice in a row before it resets the clock, because one payout holding
    the owner lock can time out a single probe.
  - If more than 300 s pass with no observation, the clock restarts at the next success instead
    of vouching for the silence.
  - The clock lives in memory, so it can never claim more than `pool.up_days`.
- *`payouts.frozen`* is the kill-switch as a bare boolean, or `null` when unknown. The reason and
  the person who set it stay admin-only. `/api/account/:addr` already returned the same flag as
  `payouts_frozen`. A frozen pool turns the Payouts lamp amber and takes the master lamp off
  "All systems nominal".
- Pinned by `scripts/test-node-availability.js` [8].

### 20.6 Admin APIs and page

- `GET /api/admin/node-events?network=&range=7d|30d|90d|1y` returns both sources' rows.
- `GET /api/admin/node-availability?range=` returns, per source: uptime %, counts by class, MTBF,
  longest outage, and a daily availability series.
- Both use the existing admin middleware and rate limit.
- The page `admin-panel/node-availability.html` sits in the Health nav group. Its KPIs show the two
  sources side by side. When no recorder is installed, its empty state names hub 08 → Diagnostics.
- **As built (2026-10-03, never run):** the page sits in the Dashboard nav group, under
  System Health. The detail is in `script07_implementation.md` §10.15 *Admin page*.

### 20.7–20.8 As built → `script07_implementation.md` §10.15

The backend as-built deltas (formerly §20.7) and the independent review of the build (formerly §20.8)
moved to `script07_implementation.md` §10.15 on 2026-10-03, with the admin-page and lamp notes. Where the
build differs from §20.1–§20.6, the implementation doc wins: for example, `node_events.state` has
seven values there, not the few named above.

# Ports

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

# Follow-ups

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

# Moved to companion files

## 19. Games platform (/play/) → `script07_design_games.md`

The games, events and chat platform (§19.1–§19.17) is its own file:
[`script07_design_games.md`](script07_design_games.md). Section numbers are unchanged.

## Appendix — Solo private pool flowchart → `script07_reference_solo_flowchart.md`

The solo miner is a separate product; its flowchart is
[`script07_reference_solo_flowchart.md`](script07_reference_solo_flowchart.md).
