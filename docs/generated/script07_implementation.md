# Script 07 — Public Mining Pool (Implementation)

> **Covers code as of:** 2026-09-07, except §8.7 and the §4/§8.2/§11 rows that point at it (2026-09-23, the uncommitted hub-move + latency working tree) and §10.6 (2026-09-24, the uncommitted §18 Parts 1–6 working tree) and §10.7 (2026-09-24, the uncommitted explorer-setting working tree) and §10.8 plus the §2 auto-payout / chain-watch / Tor-send rows, D10 and the §3 scheduler rows (2026-09-25, the uncommitted Tor-payout-hardening working tree) and §10.9 (2026-09-25, the uncommitted account-page payout-feedback working tree) and §10.10 plus the §2 "Tor send method" / "Auto-payout" rows, the two §3 withdrawal rows and the dated notes heading §10.5, §10.8 and closing §10.9 (2026-09-26, the uncommitted one-attempt Tor payout working tree) and §10.10 *Review fixes* plus the §3 scheduler-loop row (2026-09-27, the uncommitted /review-fix working tree) and §10.10 *Slatepack finalize binding* (2026-09-27, the uncommitted binding-fix working tree) and §10.11 plus the §3 scheduler-loop row (2026-09-27, the uncommitted expiry-gate working tree) and §10.12 (2026-09-27, the uncommitted admin-Miners-page working tree) and §10.13 (2026-09-27, the uncommitted games-platform Part 2, Part 3, Part 4, Part 5 and Part 6 working trees; *Part 7*, *Part 8*, *Part 9*, *Part 10*, *Part 11* and *Part 12* 2026-09-28, the uncommitted Part 7–12 working trees) · **Last verified:** 2026-09-28, PARTIAL — **§10.13 *Part 12* only, by the session that built it**: its file table, the operator steps and the counts read against `play/server/lib/{names,auth,chat,leaderboard,events,matches,moderation,app,db,settings}.js`, `play/shell/js/play-names.js`, `admin-panel/games-names.html` as written; games `npm test` 1010/1010, pool 2341/2341; no browser probe. Before that, 2026-09-28, PARTIAL — **§10.13 *Part 11* only, by the Part 11 review session**: its file table and counts read against the edited files; games `npm test` 921/921, pool 2330/2330. Before that, 2026-09-28, PARTIAL — **§10.13 *Part 10* only, by the session that built it**: its file table, the void rules and the test counts read against `play/server/lib/{matches,ratings,settings,app,moderation}.js`, `play/shell/js/{play-lobby,play-shell,play-boards,frame-host}.js`, `admin-panel/games{,-players}.html` as written; games `npm test` 918/918, pool 2322/2322, a one-shot headless-Edge probe (dark only, admin pages not opened) · earlier the same day, **§10.13 *Part 8* + *Part 9* only, by the session that built them**: their file tables, the moderator set-up steps and the test counts read against `play/server/lib/{chat,moderation,auth,settings,db,app}.js`, `play/shell/js/play-chat.js`, `admin-panel/games{,-chat,-players}.html` + `games-admin.js` as written; games `npm test` 815/815, pool 2322/2322, the headless-Edge probe 58/58 · earlier the same day, **§10.13 *Part 7* only, by the session that built it**: its file table, finalise order and test list read against `play/server/lib/{leaderboard,events,admin,badges}.js`, `lib/events/*`, `play/shell/js/play-boards.js`, `admin-panel/games-events.html` and `admin-shell.js` as written; games `npm test` 630/630, pool `npm test` 2301/2301, a headless-Edge probe 58/58 of the /play/ panel; `games-events.html` checked statically only. Before that, 2026-09-27, PARTIAL — **§10.13 *Part 6* only, by the session that built it**: its file table and test list read against `play/shell/`, `play/games/chess/frame/`, `public_html/js/public-shell.js` and `_pgs_stage_trees` as written; games `npm test` 519/519, pool `npm test` 2290/2290, the headless-Edge probe 48/48 against the staged tree. Before that, 2026-09-27, PARTIAL — **§10.13 *Part 5* only, by the session that built it**: its file table, move order and test list read against `play/server/lib/{registry,matches}.js` and `play/games/chess/` as written, games `npm test` 451/451. Before that, 2026-09-27, PARTIAL — **§10.13 *Part 4* only, by the session that built it**: its file table and rules read against `play/server/lib/` and `index.js` as edited that session; games `npm test` 318/318 on Windows (`test-auth.js` 163, `test-skeleton.js` 155), four mutations each seen turning `test-auth.js` red; nothing run on a VPS. Before that: 2026-09-27, PARTIAL — **§10.13 *Part 3* only, by the session that built it**: written against `07_lib_pool_games.sh` and the pool/backup/migrate hooks as edited that session; `bash -n` on all four files; the nginx snippet heredoc rendered with the mainnet constants and read; `_pgs_stage_trees` run once against the checkout; no shellcheck on the box; nothing run on a VPS (the toolkit cannot run on Windows). Before that: 2026-09-27, PARTIAL — **§10.12 only, by the session that built it**: written against the code as edited that session (`lib/miner-status.js` in full, the two `index.js` routes, `miners.html`, the `admin-shell.js` `urlQuery` option); the query plans run with `EXPLAIN QUERY PLAN` on the real schema; `npm test` exit 0 with `test-admin-miners.js` 50/50, `test-admin-panel.js` 142/142 and NEW `test-shares-plans.js` 28/28 (which also FAILS 7 against the committed pre-fix code, i.e. it catches what it claims to); three one-shot jsdom renders of `miners.html` against stubbed API data (expand, refresh, chips, sort, ban dialog, `?q=`; the per-row fetch cadence and one-Submit-one-ban; the capped-list server lookup), after a same-day review pass that re-read every file, rationed the per-row refresh, added the `shares(grin_address, created_at)` index and replaced the top-500-by-balance cap, then closed seven pre-existing one-sided-range full scans of `shares`; nothing run on a VPS or in a real browser. Before that: 2026-09-27, PARTIAL — **§10.11 and the §3 scheduler-loop row only, by the session that built them**: written against the code as edited that session (`processSlatepackExpiry` / `_expiryVerdict` / `_journalExpiryHold` / `_noteExpiryGate` / `_resolveQuietAlert`, `foldPayoutAlerts`, NEW `lib/grin-wallet-version.js`, the `index.js` health fold, `health.html`, `settings-payout.html`, `_pw_tor_exposure_check`); the grin-wallet v5.5.0 facts read in a local clone of tag `v5.5.0` (`ffcdf78`) that session; the G checks seen failing on the pre-gate scheduler (16 failed, section crashed); the torrc pattern run against ten sample lines; `bash -n` on the lib. `npm test` exit 0 (syntax check + every unit suite), 2041 PASS/ok lines, a total that also counts the concurrent admin-cancel change's checks; then, for §10.11 *Follow-ups*, the D checks seen failing on the committed `alert-monitor.js` and `npm test` exit 0 at 2055; nothing run on a VPS. Before that: 2026-09-27, PARTIAL — **§10.10 *Admin cancel on `tor_failed`* only, by the session that made it**: the cancel route, the `/balance/log` handler, `payments.html` and the account ledger's `eventLabel` read after the edit; the four `tor_failed` readers it names read in `lib/reconciliation.js`, `lib/withdrawal-scheduler.js` and `lib/alert-monitor.js`. Same day, PARTIAL — **§10.10 *Slatepack finalize binding* only, by the session that found and fixed it**: both finalize paths read in `lib/withdrawal-scheduler.js` after the edit, and in the committed `HEAD` for the old version; grin-wallet v5.5.0 `libwallet/src/internal/updater.rs` `cancel_tx_and_outputs`, `libwallet/src/api_impl/foreign.rs` `finalize_tx` and `libwallet/src/internal/tx.rs` `cancel_tx` / `update_stored_tx` read in the upstream source that session; the 8 B checks seen failing on the old code; `npm test` exit 0, PASS/ok lines 1991 → 2003. Same day, PARTIAL — **§10.10 *Review fixes* and the §3 scheduler-loop row only, by the session that made those fixes**: each rule read in `lib/withdrawal-scheduler.js`, `lib/wallet-tor.js` and `lib/reconciliation.js` after the edit; the grin-wallet v5.5.0 facts it rests on (`src/cmd/wallet.rs`, `controller/src/command.rs` `send` / `output_slatepack`, `api/src/owner.rs` `try_slatepack_sync_workflow`, `libwallet/src/internal/selection.rs` `select_coins` / `lock_tx_context`, `libwallet/src/api_impl/owner.rs` `cancel_tx`, `libwallet/src/api_impl/types.rs` `update_tx_slate_state`, `config/src/types.rs` timeouts) and grin v5.4.0 `util/src/logger.rs` fetched raw from GitHub that session; every new non-control check seen failing on the old code, the two F4h guard checks by mutation; `npm test` exit 0, PASS/ok lines 1943 → 1991. 2026-09-26, PARTIAL — **§10.10 *Pre-test review fix* and the *Still open* items it added only, by the pre-test review session**: the argv read in `lib/wallet-tor.js` after the edit; the v5.5.0 `grin-wallet.yml` (clap 2.34 per `Cargo.lock`), `controller/src/command.rs` `send` / `output_slatepack`, `config/src/types.rs` `TorConfig`, `config/src/config.rs`, `impls/src/adapters/tor.rs` and `impls/src/tor/process.rs` fetched raw from GitHub that session; the new argv checks seen failing on the old code (8) with both controls passing; `npm test` exit 0, 21 suites, 1942 checks. Same day, PARTIAL — **§10.10 *Follow-up fixes* and its *Still open* list only, by the session that made those fixes**: each fix written against its own test, seen failing before and passing after; `npm test` exit 0, 21 suites, 1932 checks; the nginx heredoc rendered with dummy values; the grin-wallet v5.5.0 `StoredProofInfo` / `dalek_pubkey_serde` / `lock_tx_context` facts read in the upstream source that session. Same day, PARTIAL — **§10.10 and the edits listed above only, by the one-attempt docs-fold session**. Read in the working tree that session: the scheduler constants; `sendWithdrawal`, `_settleFailedTorSend`, `_holdTor`, `_priorSendLanded`, `_txRecipientNano`, `_torAttemptWindows`, `_otherTorAttemptAt`, `reclaimStaleTorSending`, `resolveHeldTor`, `_heldAbsentSince`, `_raiseHeldAlert`, `forceRefundHeld`, `migrateLegacyTorRetries`, `torPauseStatus`, `clearTorPause`, `_assertNoRecentReversal` and `createWithdrawal`'s pause copy; the `index.js` 410 retry stub, recheck, force-refund, cancel, pause 429 and pause-clear routes and the `tor_held` status lists; `walletBin` and the 300-char stdout tail in `lib/wallet-tor.js`; the `lib/db.js` columns; the `payout_failed` codes in `lib/alert-monitor.js`; reconciliation's two lists; and the pool unit (no `KillMode`, `Restart=on-failure`). The front-end claims were **grepped** (the ids, functions and admin routes exist), not re-run. `npm test` re-run: exit 0, 21 suites, 1900 checks, with the five touched suites at the counts in §10.10. **Taken from the build and review sessions' reports, not re-checked:** the grin-wallet v5.5.0 source facts (`lock_tx_context`, `FeeFields`, `StoredProofInfo`), the R1 reproduction, every revert and mutation count, the headless probe, and the per-session suite counts before this one. 2026-09-25, PARTIAL — **§10.9 only, by the session that built it**: written against the code as edited that session, `npm test` re-run (exit 0), the four pages' inline scripts parsed, headless-Chrome screenshots at 1392 px and 390/760 px iframes; the polling path NOT run against a live backend. 2026-09-25, PARTIAL — **§10.8 *Independent review* only, by the Part 8 review session**: its two fixes read in `lib/withdrawal-scheduler.js` after the edit; the two bugs' cases (R1–R4) seen failing before the fix, and every new case seen failing with its guard removed in a scratch copy; `npm test` re-run, exit 0. Same day, PARTIAL — **§10.8, the three §2 rows, D10 and the two §3 rows only, by the Tor-payout-hardening docs-fold session**: the constants, alert types, event-note prefixes, journal strings, `chain_state` classes, the `repost -i <id> -f` argv, the `method = 'tor'` proof-backfill filter, the settings key/validator/`applyToConfig`, the two `lib/db.js` columns, the `index.js` health fold and admin-row strip, the `health.html` Critical badge and the `payments.html` `CHAIN` map were read in the working tree that session, and `withdrawal_retry_delays` was grepped absent from every admin page; `npm test` re-run, exit 0, with the five touched suites at the counts quoted in §10.8. **Taken from the build sessions' reports, not re-checked:** the grin-wallet source citations (v5.4.1 / v5.5.0), the revert-proofs and mutation counts, and deviations (a)–(f). 2026-09-24, PARTIAL — **§10.7 only, by the explorer-setting docs-fold session**: written against the code as read that session (`lib/explorers.js` in full, the `index.js` resolve helper + the three publishing routes + `/api/admin/blocks`, `lib/pool-settings.js` default/validator/`buildPublicConfig`, the `window.Explorer` block and primer in `branding.js` and `admin-shell.js`, the `blocks.html` primer, the Branding select + its testnet script, and every `Explorer.link` call site grepped); `npm test` re-run, exit 0, `test-explorers.js` 198/198. The Part 3 relink finding and the audit-row correction are taken from the code comments and the plan, not from a review report. Same day, PARTIAL — **§10.6 *Part 6* only, by the §18 Part 6 review session**: its fix read in `index.js` and the page, its two new checks seen failing before the edit and passing after, `npm test` re-run (1345/1345, 20 suites); the same session re-ran `npm test` before any edit and found every §10.6 Part 1–5 total and per-suite count exact (1343), but did **not** re-verify the rest of those Part notes' prose. Same day, PARTIAL — **§10.6 *Part 5* only, by the §18 Part 5 build session**: written against the code as edited that session, with `npm test` re-run (1343/1343, 20 suites) and a one-shot 390 px headless-Edge probe of `account-settings.html` in both themes (0 overflow, four fixtures). Same day, PARTIAL — **§10.6 *Part 4* only, by the §18 Part 4 build session**: written against the code as edited that session, with `npm test` re-run (1331/1331, 20 suites) and a one-shot 390 px + 1280 px headless-Edge probe of `donate.html` in both themes (0 overflow, five fixtures). Same day, PARTIAL — **§10.6 *Part 3* only, by the §18 Part 3 build session**: written against the code as edited that session, with `npm test` re-run (1310/1310, 20 suites, after the same-day switch to a plain-`src` preview), the cookie attributes behind that switch read in `index.js`, and a one-shot jsdom render of `donors.html` (26/26). Same day, PARTIAL — **§10.6 *Part 2* only, by the §18 Part 2 build session**: written against the code as edited that session, with `npm test` re-run (1298/1298, 20 suites), the multer size boundary measured with a one-shot fake-stream run, and the `/uploads/` nginx/rsync/backup claim grepped in the pool script. Same day, PARTIAL — **§10.6 *Part 1* only, by the §18 Part 1 build session**: written against the code as edited that session, with `npm test` re-run (1145/1145, 19 suites). 2026-09-23, PARTIAL — **§8.7 *Part 9 review fixes* only, by the review session**: each fix read in the code it wrote and its harness result as run that session. Also 2026-09-23, PARTIAL — **§8.7 only, by the doc-fold session**: its file list, menu keys, config keys, endpoint shapes and on-box paths grepped/read in the code (`07_lib_pool_backup.sh` menu dispatch, the `pmg_*` function list and manifest name in `07_lib_pool_migrate.sh`, the `GW_*` paths + `maxconn` in `07_lib_gateway.sh`, the latency keys + page CSP in the pool script, the suggest route in full in `index.js`, `lib/connect-suggest.js` constants, the three new suites in `package.json`) and `npm test` re-run, 1133/1133 across 19 suites; the step order of Migrate OUT/IN, the manifest's field list and the harness results are **taken from the build sessions' reports, not re-checked**. Before that: 2026-09-07 — §§1–8 and §11 re-derived from
> `scripts/07_grin_mining_public_pool.sh`, `scripts/lib/07_lib_{gateway,gwctl,hub,pool_backup,pool_wallet}.sh`
> and `web/07_mining_pool_public/back-end-pool/`. §§9–10 are as-written add-on notes, not re-verified — except §10.4, written against the
> code it describes on 2026-09-22 (Part 1 backend and Part 2 account page, both re-read after the
> edits) and 2026-09-23 (Part 3: every surface in its table re-read after the edit, and the CMS
> seed-once claim read in `lib/db.js`) and again by the Part 4 review (2026-09-23: §10.4's capture/verify, cost, migration and test paragraphs re-read against `lib/owner-proof.js`, `index.js` and `test-owner-gate.js`; four statements corrected in place, KDF counts measured), backed by the suite counts quoted in it. And §10.5 (payout-rails fix), written 2026-09-23 against the uncommitted diff of its three code parts — `lib/wallet.js`, `lib/wallet-tor.js` in full, `lib/socks5.js` header, `lib/config.js`, the `index.js` tor-check/pre-flight hunks, `account-settings.html` — with `npm test` re-run that session (945/945, 16 suites) and the `proxy_read_timeout` values read in `07_grin_mining_public_pool.sh`. **Taken from the build sessions' own reports, not re-checked:** the revert-proofs, the P-04 word counts, the headless-Chrome probe, and the audit of the other ten Owner calls against `owner_rpc.rs`. §10.5 then re-read by the Part 5 review (2026-09-23, PARTIAL — Parts 1–3 bullets against `lib/wallet.js`, `lib/wallet-tor.js`, `lib/socks5.js` (diffed against 06d), the `index.js` route + gate and `account-settings.html`; the ten Owner-call orders and `create_slatepack_message`/`tx_lock_outputs` re-checked against v5.4.1 `owner_rpc.rs` upstream; one claim corrected — a misspelt named key is rejected, not ignored; Part 5 fixes written against their own code, suite 960/960). The word counts and headless probe are still taken from Part 3's report.
> §1b re-verified 2026-09-21: all 49 `API_DOC_META` rows read against their handlers (static, no VPS).
> **Product code last changed:** 2026-09-28 (games platform Part 12, approved nicknames: NEW `play/server/lib/names.js`, schema v3, `play/shell/js/play-names.js`, pool `admin-panel/games-names.html` — §10.13 *Part 12*; no pool backend code) · 2026-09-28 (games platform Part 11 review fixes: global caps in `back-end-pool/lib/games-link.js`, free matches out of `results_daily` in `play/server/lib/matches.js`, the sign-in hint, the pool menu's B row — §10.13 *Part 11*) · 2026-09-28 (games platform Part 10: PvP in `play/server/lib/matches.js`, NEW `lib/ratings.js` + `scripts/test-pvp.js`, four PvP settings; NEW `play/shell/js/play-lobby.js` + the G-08 panel, the board buttons and polls in `play-shell.js`, PvP boards; pool admin `games-players.html` void + `games.html` PvP group; no pool backend code — §10.13 *Part 10*) · earlier 2026-09-28 (games platform Parts 8–9: NEW `play/server/lib/{chat,moderation}.js` + `scripts/test-chat.js`, migration v2, `play/shell/js/play-chat.js`, pool admin NEW `games.html` / `games-chat.html` / `games-players.html` / `games-admin.js` + NAV — §10.13 *Part 8* / *Part 9*; **uncommitted, not VPS-tested**). Earlier that day (games platform Part 7: NEW `play/server/lib/{leaderboard,events,admin,badges}.js` + `lib/events/` + games `scripts/test-events.js`; `app.js` / `http.js` / `pool-link.js` / `auth.js` wiring; NEW `play/shell/js/play-boards.js` + the G-06 panel; pool NEW `admin-panel/games-events.html` + the Games NAV group in `admin-shell.js`, `test-admin-panel.js` 142 → 153 — §10.13 *Part 7*; **uncommitted, not VPS-tested**). 2026-09-27 (games platform Part 6: NEW `play/shell/**` + `play/games/chess/frame/**` + games `scripts/test-shell.js`; pool `public_html/js/public-shell.js` absolute hrefs + no ads on exempt pages; the `__GRIN_PLAY_VERSION__` stamp in `07_lib_pool_games.sh` — §10.13 *Part 6*; **uncommitted, not VPS-tested**). Same day (games platform Part 5, the games service only: NEW `play/server/lib/{registry,matches}.js`, `play/games/chess/`, `scripts/test-matches.js`; uncommitted). Same day (games platform Part 4, the games service only: NEW `play/server/lib/{pool-link,ratelimit,ledger,plays,sessions,auth,mode,settings,mask}.js` + `scripts/test-auth.js`, wiring in `lib/app.js` / `index.js` / `lib/http.js`; games suite 155 → 318 — §10.13 *Part 4*; **uncommitted, not VPS-tested**). Same day (games platform Part 3, the operator side: NEW `scripts/lib/07_lib_pool_games.sh` (menu `P`: install, deploy, nginx snippet, service, status, logs, link-secret rotation, uninstall; games VACUUM; backup/restore + cleanup hooks), hooks in `07_grin_mining_public_pool.sh` (menu row, deploy tail, `/internal/` 404 + glob include in the vhost, cron option 3, cleanup group 1b/1c, `games_port` numeric), games-DB snapshot + separate restore in `07_lib_pool_backup.sh` and `07_lib_pool_migrate.sh` — §10.13 *Part 3*; **uncommitted, not VPS-tested**). Same day (games platform Part 2, the pool link: NEW `lib/games-link.js` (three `/internal/games/*` routes above `express.json()`, the `/api/admin/games/*` proxy with step-up, the 60 s health probe, the branding `games` flag), the `games` settings section in `lib/pool-settings.js`, `games_port` + `games_link_secret_file` defaults in `lib/config.js`, mount lines + `'games'` step-up section in `index.js`, the Play nav item in `public-shell.js` + `branding.js applyGamesNav`, NEW `admin-panel/settings-games.html`, NEW `scripts/test-games-link.js`; suite 2108 → 2282 — §10.13; **uncommitted, not VPS-tested**). Same day (admin Miners page — status dot + expandable per-rig rows, NEW `lib/miner-status.js` and `GET /api/admin/miners/:addr/workers`, the list's per-row share subqueries replaced by one windowed query, `AdminTable` `urlQuery`, `getWorkersForAccount` optional short window, `shares(grin_address, created_at)` index replacing `idx_share_address`, the capped list now miners-active-first + `?search=` lookup, `AdminTable` `onSearch`, NEW `scripts/test-admin-miners.js`; upper time bounds on seven `shares` queries (`recordHashrates`, `getTopMiners`, `updateStreaks`, four `GROUP BY region` routes) + NEW `scripts/test-shares-plans.js` — §10.12; **uncommitted, not VPS-tested**). Same day (slatepack expiry gate — refund only on wallet evidence, settle a mined slate, hold one finalized outside the backend; grin-wallet version on the Health card; the *Pool wallet safety* note on Payout settings; the toolkit's Tor-exposure warning; then the account page's `grin-wallet receive -m` hint and the "paid twice?" alarm on the Health card with a step-up **Mark reconciled** (NEW `POST /api/admin/alerts/:alertId/resolve`) — §10.11; **uncommitted, not VPS-tested**). Same day (admin cancel refuses `tor_failed`; payout rows name their rail in the account ledger and the admin payments badge — §10.10 *Admin cancel on `tor_failed`*; **uncommitted, not VPS-tested**). Same day (Slatepack finalize binding: both finalize paths refuse a reply when the row has no slate id yet or the reply has none — §10.10 *Slatepack finalize binding*; **uncommitted, not VPS-tested**). Same day (/review fixes #1–#6 — Held refunds wait for a resume and an intact wallet history, the Tor CLI holds the send lock, the CLI's stdout reaches the settlement, the forced refund reads `tx_slate_state`, the unrecorded-send audit compares NET, the send timeout is 360 s — §10.10 *Review fixes*; **uncommitted, not VPS-tested**). 2026-09-26 (homepage P-04 default 30D, un-serialised refresh, status stale-while-revalidate, `idx_withdrawal_confirmed` — §9 P-04 bullet). Same day (pre-test review — the grin-wallet argv in `lib/wallet-tor.js`: `--top_level_dir`, and `send`'s amount as its positional arg instead of `-a`; `repost` likewise; payout-rails 150 → 160; §10.10 *Pre-test review fix*; **uncommitted, not VPS-tested**). Same day (follow-up fixes — `AlertMonitor.foldPayoutAlerts` + the health route, `auditWalletSends` without `tor_failed`, `_captureTorSlateId` on attempt windows, two payout validators + form bounds, a 90 s nginx block for the withdraw POST in `07_grin_mining_public_pool.sh`, `socks` removed from `package.json` + lockfile; §10.10 *Follow-up fixes*; **uncommitted, not VPS-tested**). Same day (Tor payouts: one attempt, then an answer — `lib/withdrawal-scheduler.js`, `lib/wallet-tor.js` (the `walletBin` fix for mainnet payout #10, and stepwise delivery deleted), `lib/wallet.js`, `lib/db.js`, `lib/pool-settings.js`, `lib/config.js`, `lib/alert-monitor.js`, `lib/reconciliation.js`, `index.js`, `public_html/account-settings.html`, `public_html/js/payout-methods.js`, `public_html/index.html`, admin `payments.html` / `index.html` / `miners.html` / `settings-payout.html`, five test suites; stepwise F5 and the retry ladder deleted; §10.10; **uncommitted, not VPS-tested**). 2026-09-25 (account-page payout feedback + placard number rule — `public_html/account-settings.html`, NEW `public_html/js/num-format.js`, `payment-history.html`, `donate.html`, `fortune-board.html`, `js/branding.js`; front end only; §10.9; **uncommitted, not VPS-tested**). Same day 2026-09-25 (Tor payout hardening, Part 8 review fixes — the per-row freeze re-check and `_dropStepwiseSlate` in `checkTorAndSend`, `lib/withdrawal-scheduler.js`; `test-payout-guard.js` 220 → 233; §10.8 *Independent review*; **uncommitted, not VPS-tested**). Same day (Tor payout hardening F1–F5 + the exit-0 slatepack fallback — `lib/withdrawal-scheduler.js`, `lib/wallet.js`, `lib/wallet-tor.js`, `lib/db.js`, `lib/pool-settings.js`, `lib/config.js`, `index.js`, `admin-panel/health.html` / `payments.html` / `settings-payout.html`, five test suites; §10.8; **uncommitted, not VPS-tested**). 2026-09-24 (operator-selectable mainnet explorer — NEW `lib/explorers.js`, `branding.explorer_mainnet` in `lib/pool-settings.js`, `explorer` published on three routes in `index.js`, `window.Explorer` + relink in `branding.js`/`admin-shell.js`, the `blocks.html` primer, the Branding select, NEW `test-explorers.js`; §10.7; **uncommitted, not VPS-tested**). Same day (hub move, review P1 — Migrate OUT removes the weekly VACUUM cron and refuses while a vacuum runs, §8.7 *Part 9 review fixes*). Same day (donations v2, design §18 Part 6 review fix — `index.js` `requireBothProofs` refusal code `match` → `wrong_kind`, `account-settings.html` `DP_REASONS` key; suite 1343 → 1345; **uncommitted, not VPS-tested** — §10.6 *Part 6*). Same day (donations v2, design §18 Part 5 — account page: `public_html/account-settings.html` P-05 donation row from `donation`, P-03 per-rig badge, NEW P-09 Donor profile panel; `index.js` drops the v1 account aliases `donation_percent` / `donor_name` / `donor_name_state` + api-docs row; suite 1331 → 1343; **uncommitted, not VPS-tested** — §10.6 *Part 5*). Same day (donations v2, design §18 Part 4 — public wall: `lib/donor-ledger.js donorWall()` card `banner` under the Top-N slot rule + `ranking.banner_slots`, `current_percent` dropped; `bannerSlots` exported from `lib/donor-profiles.js`; `index.js` donors route comment + `API_DOC_META` row v3; `public_html/donate.html` D-01 rewrite, new D-01b, D-03 Top-N spotlight + §18.3 card copy; suite 1310 → 1331; **uncommitted, not VPS-tested** — §10.6 *Part 4*). Same day (donations v2, design §18 Part 3 — admin review queue: `index.js` donor admin routes rewritten (queue, image, approve/reject/remove/block/unblock, summary + dashboard pending count; censor/uncensor + the settings-save rescan removed; wall + account names from approved profiles only), `lib/donor-names.js` reduced to words + flags + settings, `lib/donor-profiles.js` admin reads, `lib/donor-ledger.js` names via `publicProfiles`, `donor_censored_display` removed from `lib/pool-settings.js`, `admin-panel/donors.html` rewritten, `admin-shell.js` badge + `AdminTable.onRender`, `admin-panel/index.html` tile, banner previews from a plain same-origin `src` (admin CSP unchanged — a comment only in `07_grin_mining_public_pool.sh`); suite 1298 → 1310; **uncommitted, not VPS-tested** — §10.6 *Part 3*). Same day (donations v2, design §18 Part 2 — donor-profile backend: `donor_requests` + `donor_blocks` in `lib/db.js`, NEW `lib/donor-profiles.js` (name rules, banner sniff + header dims, the request state machine, approved files under `uploads/donors/`, `profileFor` / `publicProfiles`), `leagueRank()` in `lib/donor-ledger.js`, `SNIFFERS` exported from `lib/asset-manager.js`, `donor_banner_slots` in `lib/pool-settings.js` + `lib/donor-names.js`, `index.js` `requireBothProofs` purpose wording + three `/api/account/:addr/donor-profile` routes + account `donor_profile`; NEW `scripts/test-donor-profiles.js`, suite 1145 → 1298; **uncommitted, not VPS-tested** — §10.6 *Part 2*). Same day (donations v2, design §18 Part 1 — the donation is per SHARE: `lib/rewards.js` `donateMap`, `lib/incentives.js` `applyToDistribution(…, donateMap)`, stored-% machinery removed from `incentives.js` / `stratum-server.js` / `miners.js` / `stratum-protocol.js` (`donor_label`), NEW `liveDonations()` in `lib/donor-ledger.js`, additive `donation` / `donate_percent` / `rigs_donating` / `pct_min` / `pct_max` fields on four routes in `index.js`; suite 1134 → 1145; **uncommitted, not VPS-tested** — §10.6). 2026-09-23 (Part 9 review fixes C1–C6 in `07_lib_pool_migrate.sh` + `07_lib_pool_backup.sh`, §8.7 *Part 9 review fixes*). Same day (hub move + connect-page latency, §8.7: NEW `07_lib_pool_migrate.sh` (`B → 6/7`), shared freeze/archive/restore cores in `07_lib_pool_backup.sh`, gateway re-resolve timer + `6) Latency probe` in `07_lib_gateway.sh`, hub `/ping` + CSP + pairing warning in the pool script; backend seeds v3 + local-region stamp, NEW `lib/region-rtt.js` / `lib/connect-suggest.js` / `lib/latency-probe.js`, `/api/pool/connect/suggest`, `hub_rtt_ms`/`is_hub`, `connection.latency`; connect-page measurement in `reactor-dashboard.js`; suite 960 → 1133, 16 → 19 suites; **uncommitted, not VPS-tested**). Same day (payout-rails fix, §10.5: `create_slatepack_message` named params in `lib/wallet.js`; Tor probe ported from 06d — `lib/wallet-tor.js`, new `lib/socks5.js`, `lib/config.js` 8 s default, `index.js` `?fresh=1`; P-04 slimmed in `account-settings.html`; new `scripts/test-payout-rails.js`, suite 881 → 945; then the Part 5 review's three fixes — an absolute reply deadline and proxy-protocol errors → null in `lib/wallet-tor.js`, a `res.destroyed` guard in the `index.js` pre-flight gate — suite 945 → 960; **not VPS-tested**). Same day (ownership-proof SET, design §17 Part 4 review — three fixes: `migrateProofSet` now runs before `stratumServer.start()`, `_captureProof` re-locates a racing duplicate by its digest instead of evicting a second proof, a returning evicted anchor restarts `first_seen_at`; plus the `proof_too_recent` text; `test-owner-gate.js` 36 → 42, suite 875 → 881 — §10.4 "Part 4"). Same day (design §17 Part 3 — copy and comments only: `public_html/index.html` setup-guide PIN line, the Terms/Privacy/FAQ defaults in `lib/pool-settings.js`, `index.js` (`anchor_not_accepted_here` text, one `API_DOC_META` row, one comment), `lib/stratum-server.js` / `lib/owner-proof.js` / `lib/db.js` comments; suite unchanged at 875/875 — §10.4 "Part 3"). 2026-09-22 (ownership-proof SET, design §17 Part 2 — account page: `public_html/account-settings.html` only — `proofHintText()` renders `a.proofs` as counts + last-added instead of two booleans, the "Evidence changed" banner and the `evidence` argument deleted, `renderPasswordProof(pp, proofs)` warns only past `proofs.max` ("Too many passwords") with several passwords inside the cap now an OK line, `PASS_STATE_TEXT.ok` reworded, the `Accepted:` line and three fold paragraphs restated for a set of ten, DEMO dataset reshaped; suite unchanged at 875/875 — §10.4 "Part 2". Same day, Part 1 — backend: `miner_proofs` table + `miner_accounts.proof_salt`, per-address scrypt salt, set capture/verify with LRU eviction and a flagged-not-deleted anchor, `migrateProofSet()` replacing `migrateOwnerProofHashes`+`backfillProofAnchors`, `proofs` on the account and admin miner views, `test-owner-gate.js` 19 → 36 and `test-public-leakage.js` 77 → 86 — §10.4. 2026-09-21 (donor names, design §16 Part 5 — the independent review: two fixes in `lib/donor-names.js` (rescan parses the list once per walk; a separators-only label is no label), `test-donor-names.js` 148 → 156, design §16.12 written — §10.3 "Part 5". Same day, Part 4: `/api/pool/donors` v2 — league/past/totals/ranking via `lib/donor-ledger.js donorWall()`, `donate.html` D-03 league + past strip + ranking sentence + not-verified line, D-01 `yourbrandname-donate10`, api-docs row, `test-donor-league.js` 68/68, leakage §9 — §10.3 "Part 4". Same day, Part 3: admin → Donors page, `GET /api/admin/donors` + `/summary`, `POST …/censor|uncensor` audited, rescan on list/pool-name change, dashboard `new_donor_names_7d` + nav badge, `allow_miner_donations`/`donation_address` moved off `settings-incentives.html`, `parseDonateToken` export, `check-syntax.js` type-sniff fix — §10.3 "Part 3". Same day, Part 2: six `donor_*` columns, `lib/donor-names.js` + `lib/donor-ledger.js`, six `incentives` settings keys, capture on the from-zero set only, `/api/account/:addr` `donor_name` + state, account-page row — §10.3 "Part 2". Same day, Part 1: worker part case-folded, label cap 25 → 32, raw 40 → 48, `donor_label` — §10.3 "Part 1". Same day: api-docs audit: 9 meta rows corrected, the drift-check
> regex line-anchored, and `GET /api/account/:addr/shares` un-broken — it had answered `{}` since it
> was written because `getSharesForMiner` was `async` and never awaited. Same day: P-02b lamps show workers; P-03 prints the share COUNT, not the summed difficulty; P-04 24H trace gap-filled with zeros — §7 row 4, §9. Same day: account `is_online` per rig, not per address; donor-wall totals over every donor and `active_donors` from live tags — §10.3. 2026-09-20: share credit unit + one shared `MinerManager` — first live-miner test found every hashrate at 0.00 G/s and MINERS ONLINE 0; §7 rows 3 and 5. Earlier the same day: pairing string carries the public port; gateway Status boot line, design §13.12s) — `scripts/07_grin_mining_*.sh`, `scripts/lib/07_lib_*.sh`, `web/07_mining_pool_public/`

Deployment layout, build/wiring status, database runbook, pre-launch checklist, multi-region
(Model C) as-built, and troubleshooting for the public pool. Design lives in
[`script07_design.md`](script07_design.md); security in
[`script07_security_audit.md`](script07_security_audit.md).

> **Roles:** a box is either the **brain** (`singlebox` — the pool, serving its own miners — or a
> mining-less `hub`) or a **regional gateway** (a thin HAProxy + WireGuard stratum forwarder with
> no node, no wallet, no DB, no Node.js). The old **satellite/relay** role — a full node + share
> relay per region — was deleted from the code on 2026-06-22 (`f2ebade`). Nothing runs it any more;
> it survives only as a *legacy-footprint detector* so `Z) Cleanup` can still remove one (§1).

---

## 1. Deployment layout

**Repo:**
```
scripts/07_grin_mining_hub_services.sh    mining-type selector (solo internet/LAN · pool mainnet/testnet)
scripts/07_grin_mining_public_pool.sh     mode selector → singlebox | hub | gateway | cleanup
scripts/lib/07_lib_hub.sh                 Central Hub menu (brain, reuses the parent's pool_* steps)
scripts/lib/07_lib_gateway.sh             Regional GATEWAY install (haproxy + wireguard only)
scripts/lib/07_lib_gwctl.sh               installs /usr/local/bin/grin-gateway-ctl (sole WG mutation path)
scripts/lib/07_lib_pool_wallet.sh         pw_*: combined Owner+Foreign listener, autostart, watchdog
scripts/lib/07_lib_pool_backup.sh         pbk_*: encrypted backup/restore on the shared gbe_/gbp_ engine
scripts/lib/nginx_shared_helpers.sh       shared nginx rate-limit-zone primitives
web/07_mining_pool_public/
  back-end-pool/        Express backend (index.js, lib/, admin-panel/, public/)
  public_html/          static frontend (nginx serves)
```

**Production (VPS)** — every path is network-keyed; mainnet and testnet never share one:

| | Mainnet | Testnet |
|---|---|---|
| App dir | `/opt/grin/pubpool/mainnet/` | `/opt/grin/pubpool/testnet/` |
| Database | `<app dir>/pool.db` (+ `-wal`/`-shm`) | same |
| Config | `/opt/grin/conf/grin_pubpool.json` | `/opt/grin/conf/grin_pubpool_testnet.json` |
| Wallet dir | `/opt/grin/pubpoolwallet/mainnet/` | `/opt/grin/pubpoolwallet/testnet/` |
| Frontend | `/var/www/grin-pool/` | `/var/www/grin-pool-testnet/` |
| nginx vhost | `/etc/nginx/sites-available/grin-public-pool-mainnet` | `…-testnet` |
| systemd | `grin-pool-manager.service` | `grin-pool-manager-testnet.service` |
| Log | `/opt/grin/logs/grin-pool.log` | `/opt/grin/logs/grin-pool-testnet.log` |

Gateway boxes carry a completely different footprint: `/opt/grin/conf/grin_gateway.json`,
`/opt/grin/gateway/haproxy.cfg`, service `grin-gateway`, tunnel `wg-grinpool`
(`/etc/wireguard/wg-grinpool.conf`), log `/opt/grin/logs/grin-gateway.log`.

> **Legacy paths still recognised:** the pre-2026-06 generic names (`grin_pool.json`, `/opt/grin/pool`,
> `/opt/grin/wallet`, vhost `grin-pool`) and the retired satellite footprint (`grin_satellite.json`,
> `/opt/grin/satellite`, service `grin-satellite`) are detected by `Z) Cleanup` and by the
> mode-collision guard — a legacy satellite still binds :3333, so it blocks a brain or gateway
> install until it is removed. That detector is the ONLY remaining satellite code in the repo.

### systemd unit (per network)
```
[Service]
Type=simple
User=grinpool                       # de-rooted (design §13.9): the backend parses untrusted
WorkingDirectory=/opt/grin/pubpool/<net>          # input on TWO public surfaces (HTTP + raw stratum)
Environment="GRIN_POOL_CONF=<conf>" "NODE_ENV=production" "HOST=127.0.0.1" "PORT=<8080|8090>"
ExecStart=<node> index.js
Restart=on-failure
RestartSec=5
LimitNOFILE=65535
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
RestrictSUIDSGID=yes
ReadWritePaths=-<app dir> -/opt/grin/conf -<wallet dir> -/opt/grin/logs -/etc/wireguard
```
Three traps in that unit, all load-bearing:
- **No `NoNewPrivileges`** — it would break the scoped `sudo grin-gateway-ctl` the admin panel's
  pairing path uses.
- **`/etc/wireguard` in `ReadWritePaths` is not optional.** `ProtectSystem=strict` builds a mount
  namespace that every child inherits *including one that becomes root through setuid sudo*. Without
  the entry, `add-peer`/`remove-peer`/`init-server` fail from the panel while `list`/`status` keep
  working — the page looks healthy right up to the moment you save.
- **`ReadWritePaths` is bound at service start**, so `/etc/wireguard` must exist before the unit
  starts (`pool_ensure_wg_prereqs`); a directory created later is not writable inside the namespace.

The backend handles SIGTERM/SIGINT → stop scheduler → `server.close` → `db.close()` so the SQLite
WAL flushes cleanly on `systemctl stop`. `logrotate` rotates `$POOL_LOG` daily/20 M. The **wallet**
listener has its own `@reboot` autostart + `*/5` watchdog cron (`pw_watchdog_install`, menu `5`);
the pool service itself relies on `Restart=on-failure`, not a cron watchdog.

### nginx
- `/api/*` → `proxy_pass` to the backend (`127.0.0.1:8080`/`8090`); `/*` → static `$POOL_WEB_DIR`.
- `robots.txt`/`sitemap.xml`/`manifest.json` are exact-match `location =` proxies (win over static).
- Rate-limit zones via the shared helper only — **never inline `limit_req_zone`**. Script-specific
  zones use a `script07-` conf prefix (`/etc/nginx/conf.d/script07-<service>.conf`); `/custom/`
  sets `X-Content-Type-Options: nosniff` + a sandbox CSP (see security audit).
- **Three** security-header snippets in `/etc/nginx/snippets/` (`…-headers.conf`,
  `…-page-headers.conf`, `…-admin-headers.conf`) — `/admin/` is static-served, so the vhost *is* the
  panel's CSP, and any block with an `add_header` of its own must re-include one (memory
  `project_pool_nginx_header_snippets`). Cleanup removes them in the same `rm` as the vhost that
  includes them, never before it: an orphaned `include` fails `nginx -t`.
- `nginx -t` before every reload.

### Installer responsibilities
- Node ≥ 24 guard (`node:sqlite`) with NodeSource auto-install (`pool_ensure_node24`); `npm ci` in
  the app dir. **The gateway box deliberately has no Node.js** — `07_lib_gateway.sh` reads/writes
  its JSON with `python3`, and must never shell out to `node`.
- Generate `jwt_secret` **once at install** into the pool config. `validateConfig()` throws at boot
  on a missing/short (<32 char) secret rather than minting one — a fresh secret each restart
  silently logs out every admin and breaks refresh tokens.
- Create/migrate schema via `db.js` (`createSchema()`, additive `ALTER TABLE ADD COLUMN` guards).
- `pool_deroot()` creates the `grinpool` service user, chowns what the app must write, and writes
  the scoped sudoers entry allowing exactly one binary (`grin-gateway-ctl`) as root.
- Write the systemd unit + logrotate + VACUUM/backup cron wrappers; `nginx -t`; certbot for SSL.
- `pool_configure()` prompts: pool name, domain, network, ports, `pool_fee_percent`,
  `pool_fee_address`, `min_withdrawal`, `confirm_depth`, region (default `main`).
- **Gateway install** (`07_lib_gateway.sh`): `haproxy` + `wireguard-tools` + `python3` only — no
  node, no npm, no grin node, no build tools. **Hub install** (`07_lib_hub.sh`) is 91 lines: a bare
  hub is a singlebox with no local stratum, so it reuses the parent's `pool_*` steps and the
  parent's WireGuard menu wholesale.
- Every `.sh` change passes `bash -n` before commit.

---

## 2. Implementation status (verified against `web/07_mining_pool_public/`, 2026-09-07)

✅ done · ⚠ partial · ❌ not built

| Area | Status | Notes |
|---|---|---|
| Ports reconciled `3333/3416/8080` | ✅ | `config.js` (stratum 3333/13333, node upstream 3416/13416, HTTP 8080/8090) — bash + backend in sync. The node upstream is grin's own `stratum_server_addr` default: Script 01 never moves it, so the `3334` an earlier plan named was never implemented. |
| Role split | ✅ | `singlebox` \| `hub` in `config.js`; the app has **no third role**. A gateway runs no Node process at all, so it is not an app role — `07_lib_gateway.sh` deploys HAProxy + WireGuard and nothing else. |
| Stratum proxy | ✅ | `stratum-server.js` (public) + `node-stratum-client.js` (upstream) |
| PROXY-protocol v2 ingress | ✅ | pure-JS parser in `stratum-server.js` (`PROXY_V2_SIG`, 256-byte cap, `absent` → treat as a direct miner). Armed on **region listeners only** — the public `:3333` listener is always raw stratum, so a PROXY header cannot be used there to forge a source IP (audit §J6-3a). |
| Per-region stratum listeners | ✅ | `config.region_ports` `{ "<region>": <port> }`, bound to `region_listen_host` (the WireGuard server IP in prod; loopback by default so a misconfigured box never exposes them). Region is stamped from **which listener the share arrived on**, not from a string the edge sends. |
| Regional gateway deploy | ✅ | `07_lib_gateway.sh` (haproxy `mode tcp` + `send-proxy-v2` + a `stick-table` conn-rate limit, privileges dropped after bind) + `07_lib_gwctl.sh` |
| WireGuard pairing, single mutation path | ✅ | `/usr/local/bin/grin-gateway-ctl` is the ONLY code that edits `/etc/wireguard/wg-grinpool*.conf` **and** `region_ports`, so the peer list and the port map cannot drift. Both callers use it: menu `W` over SSH, and the admin panel via scoped `sudo`. Always emits one JSON object. |
| Multi-region observability | ✅ | `shares.region` column + `pool_locations` table; `GET /api/pool/stats/regions`, `/api/pool/locations`, admin `GET/POST/DELETE /api/admin/locations`, `GET /api/admin/health/gateways` (share recency ∧ wg handshake age → online/stale/offline, plus an active TCP probe of each declared public stratum URL) |
| Public account API | ✅ | `GET /api/account/:addr` (summary), `/balance/log`, `/shares`, `/tor-check`; `POST /api/account/:addr/withdraw` → `WithdrawalScheduler` (CAS lock, 1-pending-per-address **across rails**) |
| Admin miners + testnet inject | ✅ | `GET /api/admin/miners[/:addr]`; `POST /api/admin/miners/:addr/inject` (testnet-only, 403 on mainnet) writes `balance_log` + audit row |
| Local block crediting | ✅ | `stratum-server.js` → `BlockManager.creditBlock`; wired via `index.js setBlockManager`. Gateway shares take the **same** path — they are local shares that arrived on a region listener. |
| PPLNS payout trigger | ✅ | `block-monitor.js distributeConfirmedBlocks` each tick; idempotent `confirmed→paid` in `rewards.js`. Full chain closed: found → credit → mature/verify → confirm → distribute → balance → withdrawal |
| Retention/cleanup | ✅ | `lib/retention.js` scheduled from `index.js`; admin **Settings → Database**; height-floor share prune + age-based hashrate/alert prune |
| Encrypted backup/restore | ✅ | `07_lib_pool_backup.sh` on the shared `gbe_*`/`gbp_*` engine (menu `B`) — DB via the SQLite online-backup API, config, wallet seed, **WireGuard identity**, nginx vhost. Restoring the WG identity means gateways reconnect with zero re-pairing — on their own if the hub keeps its IP; after a hub **IP change** only with a DNS-name endpoint + the gateway re-resolve timer (else `2) Configure` on each gateway), §8.7. A planned move to a new box is `B → 6` Migrate OUT / `B → 7` Migrate IN (§8.7), built 2026-09-23, **not VPS-tested**. |
| White-label / branding / SEO | ✅ | see design §9; `branding.js`, dynamic robots/sitemap/manifest, theme builder |
| Incentives (prize pool/bonus/lottery) | ✅ | `lib/incentives.js`, `lib/lottery.js`; `donate.html`, `fortune-board.html` |
| Asset upload hardening | ✅ | see security audit §A |
| Auth hardening | ✅ | `trust proxy`+`req.ip`; bcrypt 12; account lockout; refresh-token rotation+revocation; `jwt_secret` fail-loud at boot; TOTP step-up (`freshAdmin`) on destructive routes — see security audit §B |
| Service de-rooting | ✅ | runs as `grinpool` under a hardened unit (§1); one scoped sudo target |
| System-health metrics | ✅ | real CPU/mem/disk/uptime via admin `GET /api/admin/health/system`; health page lives in the admin panel |
| Money precision (REAL → nanoGRIN) | ❌ | balances still `REAL` GRIN in `db.js` (`miner_accounts.balance REAL NOT NULL DEFAULT 0.0`) — design follow-up, see D2 |
| Auto-payout scheduler | 🗑 **not built — dead keys deleted 2026-09-25** | Payouts are miner-initiated (account page → Tor/slatepack/Nostr); the scheduler sends each Tor payout once, then only expires, refunds on proof, resolves Held rows and reclaims. The inert `payout.auto_payout` and `payout.payout_frequency` keys and their two admin inputs were deleted together (D10, §10.8 F4). A pool that stored them keeps an inert `pool_config` row. |
| Payout chain watch | ✅ **2026-09-25, not VPS-tested** | A paid row gets its kernel only once the pool wallet's tx log shows it **confirmed**. A paid row not seen mined after 1 h raises the rolling `payout_unmined` alert and gets one CLI repost per hour. Admin payments shows `chain_state` per row. §10.8 F1/F2. |
| Tor send method | ✅ **2026-09-26, one attempt, not VPS-tested** | ONE `grin-wallet send -d` per payout, spawned from `<wallet_dir>/grin-wallet` (a bare `grin-wallet` was ENOENT — mainnet payout #10). It ends Paid, Failed (refunded only on wallet proof, with a `fail_code`) or Held (locked, never re-sent). There is no retry ladder, and a Tor pause applies after 5 counted failures in 24 h. The stepwise sender (`tor_send_mode`) was deleted on 2026-09-26. Design §8, §10.10. |
| Grin Transporter payout rail | 🗑 **removed 2026-08-13** | never had pool-side code; the dead `lib/wallet-transporter.js` stub went 2026-08-06 and the last two artefacts (`incentives.transporter_enabled` + the disabled admin checkbox) went together on 2026-08-13. The pool ships **Tor primary + Slatepack fallback**, with Goblin/Nostr as an off-by-default operator opt-in ([093 Transporter](script09_design.md) remains a standalone product) |

### Remaining operator responsibility (not code)
- **`grin-server.toml` `wallet_listener_url`** — the node's stratum coinbase must point at the pool
  wallet's combined listener, and it must be a **BASE** url (`http://127.0.0.1:3420`): the node
  appends `/v2/foreign` itself, so a pathed url doubles the path → 404. `pw_patch_node_toml` writes
  the base url. Under Model C there is exactly **one** node and **one** wallet, both on the central
  box, so the old cross-region "which wallet gets the coinbase?" decision no longer exists.
- **The wallet password on disk** (`.wallet_pass`, 600). `owner_api` boots LOCKED and Owner API v3
  only accepts ECDH-encrypted calls, so the only unlock path is `init_secure_api` → `open_wallet`.
  That unlock must be automatic, because in Grin *receiving is a signing op*: the node calls
  `build_coinbase` for every block template (~15 s) and needs the decrypted keychain. A locked
  wallet is not "miss a reward" — it is **no jobs at all** (symptom: miners Alive, GetWorks=0).
  grin-pool (MWGrinPool) and open-grin-pool keep the password in service config the same way.
  Mitigations = low hot balance, sweep to cold; full writeup in the security audit's
  *Residual / accepted risks*. *(Operator decision, not a code gap.)*

### Deferred decisions & open items — read before mainnet

These are **intentionally not coded yet**. Each needs a product call, not more implementation guessing.
Listed here so we don't re-litigate or accidentally re-implement.

| # | Item | Status / why deferred | Recommendation |
|---|---|---|---|
| D1 | **System-health fake metrics** | ✅ **Resolved 2026-06-08** — real metrics via admin `GET /api/admin/health/system`; the health page moved into the admin panel (gated, not public). | Done. |
| D2 | **Money precision `REAL` GRIN → integer nanoGRIN** | Touches all payout/reward/withdrawal/balance_log math + display. High blast radius. **Carve-out landed 2026-07-17:** per-payout network fees are now RECORDED (`withdrawals.fee` — slatepack from the slate, Tor from the wallet tx log) and reconciliation coverage is fee-adjusted, so fee accumulation no longer false-trips `coverage_shortfall`. The REAL→nanoGRIN unit change itself stays deferred. | Do as its **own PR + full testnet soak**, never as a side-change. Engine-independent (do it in SQLite, carries to Postgres). |
| D3 | ~~**mTLS satellite→hub**~~ | 🗑 **Moot since 2026-06-22.** There is no satellite→hub HTTP ingestion to protect: the edge↔central link is a WireGuard tunnel carrying raw stratum, authenticated by the tunnel's own keypair. The shared-secret header and IP allowlist retired with the role. | Closed — do not re-open as stated. |
| D4 | **Grin Transporter payout rail** | ✅ **Closed 2026-08-13 — removed, not deferred.** Blocked indefinitely on a gate the pool does not control: no mainstream wallet can receive from a relay. A placeholder that cannot name a date is a promise, so the reserved `incentives.transporter_enabled` key and its disabled checkbox in `settings-incentives.html` were deleted **in the same commit** — the settings harvester sends every `id` in `.settings-form` (disabled inputs included) and `updateSection` throws on an unknown key, so removing either alone would have broken every Incentives save. | Done. If a relay rail is ever revisited, add it as a self-registering file under `public_html/js/` like `payout-goblin.js` — do **not** re-introduce a reserved settings key ahead of working code. A pool that already persisted `transporter_enabled` keeps an inert `pool_config` row; `getSection` merges stored rows over defaults without a membership check, so it is harmless and no migration is needed. |
| D5 | **Theme-system unification** (public `body.<theme>-theme` → `theme.js` CSS variables) | Cosmetic; refactor risk across 13 themes. | Defer; not launch-blocking. |
| D6 | **i18n / multi-language content** | Product scope; content + tooling. | Defer (phase 2). |
| D7 | **Fiat (USD/EUR/BTC) price display** | Feature; could wire to the Script 06 price collector. | Optional — your call on data source. |
| D8 | **Optional free miner accounts** (true one-person-one-entry lottery) | Conflicts with register-free identity model; partial Sybil trade-off documented (design §9). | Defer (phase 2 design decision). |
| D9 | **Admin theme live-preview iframe + WCAG contrast check** | Admin UX nicety. | Defer; not launch-blocking. |
| D10 | **Auto-payout** | ✅ **Closed 2026-09-25 — dropped for good, keys deleted like D4.** Payouts stay MINER-INITIATED (operator decision 2026-09-24, final). The ownership gate (§10) exists precisely because an ungated automatic trigger was an abuse surface. `payout.auto_payout` + `payout.payout_frequency`, their two inputs in `settings-payout.html` and the `payout_frequency` validator went in **one** change, for the D4 reason (the harvester sends every id, `updateSection` throws on an unknown key). A pool that already stored them keeps inert `pool_config` rows; `test-admin-guards.js` `[7]` proves such a pool still loads and saves. §10.8 F4. | Done. Do not re-introduce a reserved key ahead of working code. |

### Verification still owed by the operator (not changed in code)
Backend items are syntax-checked + logic-reviewed but **not** runtime-tested locally
(`node_modules` live only on the VPS). On a testnet box, confirm:
- a real **login → refresh → old-refresh-replay-rejected** cycle, and **5-fail lockout** then unlock;
- every **admin mutation writes an `admin_audit_log` row** (not line-audited per handler);
- money flow (**orphan reversal exact amounts, idempotent send, CAS balance lock**) against a live DB.

---

## 3. Scheduler jobs

All in-process (no cron except backup + VACUUM). Cadences read from the code, not from settings
unless noted.

| Job | Where | Cadence | Purpose |
|---|---|---|---|
| Block confirmation + distribution | `block-monitor.js` | 30 s | promote pending blocks past `confirm_depth` → `distributeConfirmedBlocks` |
| Orphan detection | `block-monitor.js` | 6 h | nonce-check confirmed blocks; reverse orphans (exact `balance_log` amounts) |
| Withdrawal scheduler loop | `withdrawal-scheduler.js` | 60 s | once per process first: the legacy `retry_scheduled` migration (§10.10). Each tick: reclaim stale `finalizing`, hold stale `tor_sending` (confirm on proof), resolve `tor_held` rows (before the freeze branch — it never sends; while frozen it confirms and cancels a never-finalized fallback lock but never refunds, §10.10 *Review fixes*), Tor sends (one attempt each, each holding the wallet send lock for its whole CLI run), slatepack expiry (refund only a slate the wallet shows as never finalized, settle one it shows mined, hold one finalized outside the backend — §10.11), kernel-proof backfill (confirmed tx-log entries only) + the "paid but not mined" watchdog on the same tx-log read (throttled to 3 min, §10.8 F1/F2). **Freeze-safe:** while frozen it runs only the paths that resolve or refund (slatepack expiry, which then waits on a slate missing from the wallet; a Held payout is confirmed, never refunded), never a send, and no repost of any kind. |
| ~~Withdrawal retry ladder~~ | — | — | **Removed 2026-09-26** (§10.10). No Tor payout is re-sent. A Held row is settled from the wallet tx log: confirmed, or refunded after two absent reads ≥ 10 min apart. Otherwise it waits, and after 24 h it raises a critical `payout_held` alert. |
| Hashrate sampling + hourly rollup | `hashrate-tracker.js` | 60 s / hourly | `hashrate_history`; `rollupCompletedHours()` writes the durable `pool_metrics_hourly` + `pool_region_metrics_hourly` (§9) |
| Retention | `retention.js` | `database.prune_interval_minutes` (default 60; first pass +30 s) | prune raw shares + downsample/age hashrate + prune alerts |
| Alert monitor | `alert-monitor.js` | 60 s (`alert_check_interval_secs`) | health/security alerts |
| Reconciliation + money invariants | `alert-monitor.js` → `reconciliation.js` | 300 s (`alert_money_check_interval_secs`) | coverage/flow/integrity check; can trip the payout freeze |
| Dormancy sweep | `dormancy.js` | 6 h (first pass +60 s) | 24-month abandoned-balance disposition → prize pool |
| Lottery / campaigns | `index.js` | 1 h | reveal committed draws, then run due draws + campaigns |
| Loyalty streaks | `index.js` | 24 h | `incentivesManager.updateStreaks()` |
| Network peer snapshot | `index.js` | 20 min | `snapshotNetworkPeers` — per node (mainnet + testnet when both run on the box) reads `get_connected_peers` **and** `get_peers` (the node's own peer store, stamped with its `last_connected`); the live list alone is ~8 sticky outbound seats, the store is what the node's own background probing (~100 handshakes / 20 s) has verified. Country-only rows in `network_peers`; feeds `/api/network/peers` |
| Stale stratum sessions | `stratum-server.js` | 60 s | `pruneInactiveSessions` |
| miningpoolstats submit | `poolstats-reporter.js` | `poolstats_interval_mins` (default 10) | only when `poolstats_enabled` — **push** mode; the pull feed (§8.6) needs none of this |

There is **no region-aggregation job**: regional shares are written locally by the central stratum
server as they arrive, so nothing has to be pulled from an edge box.
There is **no auto-payout job** (§2, D10).

---

## 4. Database — engine & backup runbook

**Stay on SQLite (Node's built-in `node:sqlite`) now** (one local writer; see design §4 for the
migration triggers). The safe topology is exactly ours: **one local writer process on local disk** —
SQLite does not corrupt on its own; corruption comes from misuse, all avoidable.

The live file is **`/opt/grin/pubpool/<net>/pool.db`** (plus `-wal`/`-shm`). `lib/db.js` chmods all
three to 0600 on every start.

**Rules that prevent corruption:**
- DB on the box's **local SSD** only. Cloud *block* volumes (EBS, DO Volumes) are fine; **never** a
  network filesystem (NFS/SMB).
- One process owns the file (✓ by design); one Node/`node:sqlite` version.
- **Never** `cp`/`rsync` the live `pool.db` — you can capture a torn write.
- **Never VACUUM a live database.** The shipped `/usr/local/bin/<service>-vacuum` (weekly cron,
  menu `C`) stops the service, compacts, and starts it again whatever happens; VACUUM holds an
  EXCLUSIVE lock for the whole rewrite.

**Backups — what actually ships:** menu `B` (`07_lib_pool_backup.sh`) on the shared toolkit engine —
`/opt/grin/backups/grin_pubpool[testnet]_backup_<DDMMYYYY>.tar.gz.enc`, AES-256-CBC/PBKDF2-600k,
password `<personal_key><DDMMYYYY>`, one archive per net per day, optional offsite push. The DB goes
in via the **SQLite online-backup API** (two-phase tar), never a live WAL copy. The set also carries
the config (incl. `region_ports` + `jwt_secret`), the wallet seed/toml/secrets, the **WireGuard
identity**, and the nginx vhost — everything a fresh install cannot regenerate.
Restore runbook: fresh box → Script 01 node → 07 `1) Install` → restore → `grin-secret-sync` →
re-point DNS → gateways: **same IP** → they reconnect on their own; **new IP + DNS-name endpoint +
re-resolve timer** → they follow within ~2–3 min of the DNS change, no action on the gateway box;
**new IP + raw-IP endpoint** → on each gateway `2) Configure` the new endpoint, then `3)`.
*(Corrected 2026-09-23: this line used to promise "no action on any gateway box" unconditionally,
which was true only for the same IP.)* A **planned** move to a new box — as opposed to a disaster
restore — is Migrate OUT / Migrate IN, §8.7. Only the migration archive carries the TLS
certificate; daily archives do not.

**Optional additions (not shipped, operator's call):**
- **Continuous:** [Litestream](https://litestream.io) streams the WAL to S3/B2/another disk →
  point-in-time restore, seconds of RPO.
- **Portable dump (DR/migration):** `sqlite3 pool.db .dump > pool.sql`.
- **Integrity check (nightly cron):** `PRAGMA integrity_check;` → alert if not `ok`.

**Restore (file-level):** `systemctl stop` → replace `pool.db` (or `litestream restore`) →
`systemctl start`.

**Honest limit:** SQLite's real weak spot is **HA/failover** (no built-in hot standby), not
corruption. That is the one legitimate future reason to consider Postgres.

---

## 5. Pre-launch checklist

**Money / consensus**
- [x] `confirm_depth = 1440` mainnet / `100` testnet (= Grin `COINBASE_MATURITY`) — set in code (config.js, pool-settings.js, retention.js, template, admin UI)
- [ ] Found blocks persisted; orphan reversal reverses exact `balance_log` amounts incl. fee, no neg balance
- [ ] PPLNS double-pay guard active (shares marked paid per block in the distribution transaction)
- [ ] Withdrawal balance lock is compare-and-swap; max 1 pending per address **across all rails** (`PENDING_SQL`); wallet send idempotent (`txid`)

**Auth / security** (see [`script07_security_audit.md`](script07_security_audit.md))
- [x] bcrypt ≥ 12; refresh-token revocation; account lockout (`auth.js`/`db.js`) — runtime-verify on testnet
- [x] httpOnly cookie auth (`index.js` login/register). ⚠ still verify the frontend gate `await`s an authenticated endpoint (not `/api/health`)
- [x] `trust proxy` + `req.ip` (no raw `X-Forwarded-For` trust); `jwt_secret` written at install and fail-loud at boot
- [x] Service runs as `grinpool` under the hardened unit; exactly one scoped sudo target
- [x] SVG/upload hardening (§A) + `admin_audit_log` single shape (`migrateAdminAuditLog`). ⚠ still confirm public payments/miners are aggregated/masked

**Infra / ops**
- [ ] Encrypted backup run + **a tested restore** (menu `B`); nightly `integrity_check`
- [ ] Weekly offline VACUUM cron present; graceful SIGTERM verified; HTTPS enforced; secrets only in the pool config
- [x] `bash -n` clean on all `07_*` scripts; `node --check` clean on all backend JS — ⚠ `nginx -t` runs on the VPS
- [ ] 7-day testnet soak before mainnet

---

## 6. Testnet mode

Backend is config-driven; testnet = a different config file + a fully isolated instance
(`/opt/grin/pubpool/testnet/`, config `grin_pubpool_testnet.json`, service
`grin-pool-manager-testnet`, node API `13413`, node stratum upstream `13416`, Central API `8090`,
public stratum `13333`, wallet `13420`, WireGuard iface `wg-grinpool-tn` on udp `51821` with
tunnel net `10.66.67.0/24`, region ports from `13391`). Currency label `tGRIN`; `--testnet` (never `--floonet`); `confirm_depth` defaults to 100;
the admin balance-inject endpoint is testnet-only (guarded). A testnet pool can coexist with a
mainnet pool on one box — it collides only with **solo** mining.

Quick solo/testnet smoke test (IPOLLO): init wallet, patch TOML, start listener + node stratum,
point the miner at `:3333`. (This used to point at an in-repo `grin_mining_testnet_instruction.html`;
that page was deleted on 2026-06-13 in `ea0cc43`. The solo product's own walkthrough is the
"Appendix — Solo private pool flowchart" at the end of [`script07_design.md`](script07_design.md).)

---

## 7. Troubleshooting

| Symptom | Likely cause / check |
|---|---|
| Miners connect but get no work | `NodeStratumClient` needs `pool_address` set, or it can't log in to the node's built-in stratum → no jobs. Verify `config.pool_address` and that the node stratum is up on `127.0.0.1:3416`/`13416`. |
| Miners Alive, **GetWorks = 0**, pool otherwise healthy | The pool wallet is LOCKED. `build_coinbase` needs the decrypted keychain for every template, so a locked wallet halts the whole pool, not just rewards. Re-run the ECDH unlock (`pw_*` autostart/watchdog) — after a crash or reboot the decrypted seed is gone from RAM. |
| Pool hashrate reads ~0 / meaningless | Hashrate is summed accepted-share difficulty over the window (`GPS = sumDiff × 42 / window_s / 16384`), so what each share is CREDITED must be in the chain's unit: job target × the C32 graph weight (16384), `shareCreditDifficulty()` in `stratum-protocol.js`. **This shipped wrong until 2026-09-20** — every share was written at the session's `1.0` vardiff placeholder, so the first live test (8 rigs, ~350 accepted shares) showed 0.00 G/s on every gauge, chart and worker row, and 0 % round effort. `db.js migrateShareCreditUnit` rescales pre-fix rows once (marker `share_credit_c32_units`) so PPLNS weight and luck stay in one unit across the upgrade. Sanity check after a deploy: one rig at job target 1 = `shares_per_min × 0.7 G/s`. |
| Homepage P-03 prints **millions of "SHARES"** after a few hours of one rig; P-04 24H trace shows **no dip** across a mining pause | Two consequences of the share unit above, found 2026-09-21 on grinium.com. (a) `/api/pool/effort.round_shares` is the round's SUMMED difficulty in chain units (the effort numerator, ~16384 per share — `21,544,960 / 16384 = 1315` real shares); the mimic labelled it "SHARES". The endpoint now also returns `round_share_count` (a `COUNT(*)` from the same scan) and the mimic prints that, compact (`1.3 K SHARES`), with the sum on hover. (b) `recordHashrates()` writes a `hashrate_history` row per address WITH a share that minute — a minute with none writes nothing, so a pause is a hole in TIME, and the chart's x-axis is categorical, so the two samples either side of a 3-hour pause sit one step apart and the line simply continues. `getPoolHistory()` now regularizes onto the 60 s sampling grid (`_fillGaps`: absent minute → `0`, from the first sample to now; leading absence left alone so a young pool's trace isn't squashed) before thinning. This is a KNOWN zero — the "draw a null as a gap" rule is for values the server withholds. `getAccountHistory()` (account page chart) has the same hole and is NOT changed. |
| `/api/pool/stats` disagrees with `/api/stratum/stats` (MINERS ONLINE 0 with rigs connected; every account worker "dropped"; stale/reject `–`) | Two `MinerManager` instances. **Was the shipped state until 2026-09-20**: `index.js` and the `StratumServer` constructor each made their own, and the API side's never held a session. `index.js` now injects its instance (`new StratumServer(config, minerManager)`); the constructor's private fallback is for standalone (test) construction only. |
| **100 % stale / reject** on a gateway region | **Never latency — suspect the protocol.** Two real causes, both fixed in-repo and both worth re-checking after any stratum change: the pool must echo the **node's own `job_id`** (jobIdMap, kept for the whole submit window), and the u64 **nonce must travel as a string** (`JSON.parse` rounds past 2^53 — the tell is node-logged nonces ending in zeros). |
| Miner shows "Dead" but the tunnel pings | The gateway's `hub_endpoint` points at the wrong port — e.g. the node stratum (13416) instead of the **assigned central region port** (13391). Diagnose with a raw stratum login over the tunnel (`nc`). Pasting the `GRINGW1\|…` pairing string instead of typing values makes this impossible to mistype. |
| WireGuard handshake fine, **all TCP dead** | Cryptokey-routing (AllowedIPs) mismatch — the classic cause was a duplicate add-peer moving the hub's AllowedIPs to a fresh tunnel IP while the gateway kept the old one. `grin-gateway-ctl add-peer` now refuses to re-add an existing pubkey (it re-prints the pairing string) and a region keeps its port when its box is replaced. To genuinely re-pair: **remove the peer first**, then add. Handshake age proves the tunnel, not the routing. |
| Panel pairing 502s / "saves" nothing while Regions still lists fine | The service unit is missing `/etc/wireguard` from `ReadWritePaths` (or the directory did not exist at service start) — reads work, writes cannot escape the mount namespace even as root (§1). |
| Region shows `unknown` on `/api/admin/health/gateways` | Neither signal is available yet: no share in the last 15 min **and** no wg handshake. A brand-new region declared in the panel before its peer exists reads `unknown`, not `offline`. |
| JWTs invalid after restart / boot refuses to start | `jwt_secret` missing or <32 chars in the pool config — the backend fails loud by design. Re-run the installer/configure step. |
| Allowlist / lockout bypassable | Missing `app.set('trust proxy', 1)` → code trusts spoofable `X-Forwarded-For`. Use `req.ip`. |
| Uploaded logo/icon 404s | `assets_dir` mismatch vs the app working dir, or the `/custom/` nginx alias/permissions. A re-run of `1) Install` chmods the app dir 700 — `pool_ensure_served_dirs` re-opens the two dirs nginx must reach. |
| Node "won't start" after a root run | A root-run node leaves `root:root` files → the `grin` user gets EACCES. Always run as `grin` with `HOME=$GRIN_DIR` (see CLAUDE.md launch contract). |

Diagnostics: `journalctl -u grin-pool-manager[-testnet] -f`; `systemctl status`; test node API per the
CLAUDE.md curl snippets; `sqlite3 pool.db 'PRAGMA integrity_check;'`; on a gateway,
`journalctl -u grin-gateway -f` and `wg show wg-grinpool`.

---

## 8. Multi-region (Model C) — as built

Implemented 2026-06-22 (`f2ebade`, Phases 1–8) and **live-verified on testnet 2026-07-05**: a real
regional gateway forwarded miner hashrate over WireGuard to the central pool, the pool FOUND BLOCKS
from those shares, and the coinbase arrived in the central wallet's combined listener.

**Multi-region is optional and most pools never need it.** A single pool box already serves every
miner on `:3333` as region `main`. Add a gateway only when you have miners on another continent and
want to cut their latency to the stratum endpoint.

### 8.1 Architecture

```
  Miners (Asia)          Miners (US)            Miners (EU)
     │ stratum+tcp :3333     │ :3333                 │ :3333
     ▼                       ▼                       ▼
 ┌──────────────┐     ┌──────────────┐       ┌──────────────┐
 │ Asia Gateway │     │  US Gateway  │       │  EU Gateway  │   thin edge:
 │   HAProxy    │     │   HAProxy    │       │   HAProxy    │   NO node, NO wallet,
 │ (mode tcp)   │     │              │       │              │   NO keys, NO DB, NO Node.js
 └──────┬───────┘     └──────┬───────┘       └──────┬───────┘
        │  WireGuard (wg-grinpool / udp 51820; testnet wg-grinpool-tn / 51821) carrying
        │  raw stratum bytes + PROXY-protocol v2 (real miner IP)
        └────────────────┬───┴───────────────────────┘
                         ▼
 ╔═════════════ CENTRAL BOX (= the single-box pool) ══════════════════════╗
 ║  region listeners 10.66.66.1:3391, :3392 …  ← region stamped by PORT   ║
 ║  public listener :3333 (raw stratum, no PROXY accepted)                ║
 ║        │                                                               ║
 ║        ▼ stratum-server.js → accounting → pool.db (single writer)      ║
 ║        │ stratum CLIENT (localhost) → Grin node 127.0.0.1:3416         ║
 ║        │ node build_coinbase (localhost) → wallet_listener_url         ║
 ║        ▼ grin-wallet :3420 — ONE combined listener (owner_api +        ║
 ║          include_foreign), ECDH auto-unlock → Tor/slatepack payouts    ║
 ╚════════════════════════════════════════════════════════════════════════╝
```

**Region attribution** is by **listener port**, not by a string the edge sends: each gateway's tunnel
targets its own central port (`region_ports`), and the central stratum server stamps that listener's
label on every share. This kills the old "region string must match" footgun outright. The miner's
real IP is recovered from the PROXY-v2 header — which is armed on region listeners **only**, so the
public `:3333` can never be fed a forged header.

**Why the edge is this thin:** no node means no per-region chain sync, no per-region wallet, and no
"which wallet gets the coinbase?" question — `build_coinbase` is a localhost call on the one box that
has both. All accounting stays single-writer on the central DB.

**The honest tradeoff:** every share round-trips edge→central over the tunnel for PoW validation.
Measured 2026-07-05 on a real cross-continent link: fine at Grin's C32 share rate. The 100 %-stale
episodes seen during that test were **protocol bugs, not latency** (§7).

**Not copied from a Grin reference.** Model C is the documented best-practice pattern for
multi-region pools in general (Bitcoin-scale), but no open-source Grin pool publishes this exact
topology — grin-pool is single-region, and the commercial pools' internals are unobservable from
outside. Treat latency/behaviour claims as "measure on a real link".

### 8.2 The pieces

| Piece | Where | Notes |
|---|---|---|
| WireGuard server | central | mainnet `wg-grinpool`, udp **51820**, tunnel net `10.66.66.0/24`; testnet `wg-grinpool-tn`, udp **51821**, `10.66.67.0/24`. Hub is always `.1`, gateways `.2`, `.3`, … Keys/state in `/opt/grin/conf/wg[-testnet]/`. |
| Region ports | central, `region_ports` in the pool config | allocated from **3391** (mainnet) / **13391** (testnet), bound to `region_listen_host` = the wg server IP |
| Pairing string | `GRINGW1\|region\|hub_pubkey\|hub_public_endpoint\|hub_tunnel_ip\|gw_tunnel_ip/32\|region_port\|public_stratum_port` | one line, printed by the pool box; paste it on the gateway instead of typing the values. The 8th field (since 2026-09-20) is the pool's **public miner port** — the gateway must listen on exactly it, so the gateway takes it from here rather than asking. A 7-field string from an older hub still parses (the gateway keeps its saved port); an 8-field string on a pre-2026-09-20 gateway is **rejected** (`read` folds the extra field into `region_port`) — pull both boxes together. |
| Mutation path | `/usr/local/bin/grin-gateway-ctl` (`init-server`/`add-peer`/`remove-peer`/`list`/`status`) | the ONLY writer of `/etc/wireguard/wg-grinpool*.conf` and `region_ports`; validates every input itself and computes AllowedIPs internally (`0.0.0.0/0` is unrepresentable) |
| Operator surfaces | admin panel **Regions & Gateways**, or CLI menu **W** | both call the same helper, so they cannot drift. The panel binds a new listener without the service restart the CLI path needs; the CLI is the SSH/offline fallback. |
| Hub endpoint DNS name | menu `W → 5` | pairing strings then carry a name instead of a raw IP, so a provider/IP change needs only an A-record update — each gateway's re-resolve timer (below) follows it within ~2–3 min, no re-pairing and no restart. The hub prints a warning under every `GRINGW1` string while this is empty. |
| Re-resolve timer (gateway) | `grin-gateway-reresolve` service + timer, installed by gateway `3) Bring up tunnel` | since 2026-09-23. Every 60 s: a hostname endpoint whose handshake is > 135 s old is re-set with `wg set … endpoint`, so WireGuard resolves it again. Existing gateways get it the next time `3)` runs; `5) Status` shows it and warns on an IP-literal endpoint. §8.7. |
| Latency probe (gateway, optional) | gateway `6) Latency probe` → `grin-gateway-probe` | since 2026-09-23. A separate HAProxy on `:443` answering `GET /ping` with 204 for the connect page's browser measurement. §8.7. |

### 8.3 Bring-up order

Start **singlebox** and prove the local pipeline end-to-end *before* adding a gateway. Don't debug
federation and the core pipeline at the same time.

**Pool box** (`07_grin_mining_public_pool.sh` → `1) Pool server`, or `G) Guided Full Setup`):
1. `1) Install` → `2) Configure` (pool name, domain, network, fee, region) → `3) Deploy web files`
   → `4) Setup nginx` → `5) Set up wallet` → `6) Service control` (start) → `7) Create admin`.
2. Only when adding a region: admin panel **Regions & Gateways → Enable multi-region** (or `W → 1`)
   — installs WireGuard, keys, tunnel, firewall, and sets `region_listen_host`.
3. Add the region (panel row, or `W → 2`) → it assigns a tunnel IP + region port and prints **one
   `GRINGW1|…` line**. Copy that.

**Gateway box** (a *different* box — it binds :3333 too), `07_grin_mining_public_pool.sh` →
`2) Regional gateway`:
1. `1) Install` (haproxy + wireguard-tools + python3; generates the keypair — hand its public key to
   the pool box's add-peer step).
2. `2) Configure` → paste the `GRINGW1|…` string (or type region / hub endpoint / tunnel keys).
   The public stratum port it then shows must be the **pool's** public port (`3333` mainnet): the
   admin Regions card appends that shared port to the region's hostname itself, so a gateway
   listening anywhere else is advertised on a port it does not serve. A current pairing string
   carries it (8th field) and pre-fills the prompt; the bracketed value is otherwise whatever was
   saved on this box last time, not a default.
3. `3) Bring up tunnel` (`wg-quick up wg-grinpool` — the gateway box always names its single
   tunnel `wg-grinpool`, whichever network the pool is on) → `4) Service control` → start the forwarder.
4. `5) Status` → tunnel handshake present, `:3333` listening, and `On reboot : forwarder and
   tunnel start automatically`. The two units are enabled by two different steps (`1)` enables
   `grin-gateway`, `3)` enables `wg-quick@wg-grinpool`); a box missing either reboots into
   `:3333` listening with nothing behind it, which the pool's Port check cannot tell from healthy —
   Status names the missing one and the `systemctl enable` that fixes it.

**Miner:** point lolMiner/GMiner/IPOLLO at `stratum+tcp://<gateway-ip>:3333`, username
`<grin_address>.<worker>`. Miners always connect to the public stratum port on their nearest
gateway — region ports are internal plumbing and are never miner-facing.

### 8.4 Scenario matrix

**Layer 1 — bash / deploy**
- Services exist & enabled: `grin-pool-manager[-testnet]` (pool), `grin-gateway` (gateway).
- Configs written 0600: the pool config, `/opt/grin/conf/grin_gateway.json`.
- `jwt_secret` present and **stable across a restart** (not regenerated at boot).
- Ports listening per §11; node built-in stratum is **localhost-only** (`127.0.0.1:3416`, not `0.0.0.0`);
  region listeners bound to the wg IP, **never** `0.0.0.0`.
- `bash -n` clean on all `07_*`; `node --check` clean on backend JS; `nginx -t` OK.

**Layer 2 — backend / money (single box first)**
- Share → PPLNS: submitted shares land in `shares`; a found block matures past `confirm_depth`
  (100 testnet) → `rewards` distributes; `balance_log` gets append-only rows; no share paid twice.
- Orphan path: mark a confirmed block's nonce absent from chain → reversal reverses the **exact**
  `balance_log` amounts (incl. fee), balance never < 0.
- Withdrawal: CAS balance lock (insufficient → `409`); max 1 pending per address across rails
  (`429`); idempotent send (`txid`); reversal cooldown blocks an immediate re-request.
- Ownership gate: a withdraw/finalize without a valid `proof` is refused (§10).
- Auth: login → refresh → **old refresh replay rejected**; 5-fail **lockout** then unlock; every
  admin mutation writes an `admin_audit_log` row.

**Layer 3 — multi-region (pool + one gateway)**
- A share submitted through the gateway appears in the central `shares` table tagged with **that
  region**, and `miner_ip` is the miner's real address (from PROXY-v2), not the gateway's.
- `GET /api/pool/stats/regions` shows the region's GPS/miners/shares; `/api/pool/locations` shows
  its label + public stratum URL; `GET /api/admin/health/gateways` reports it `online` with a
  recent `tunnel_handshake_age` and `stratum_reachable: true`.
- Blocks found from gateway shares credit exactly like local ones (same code path).
- Tunnel-outage drill: stop the tunnel → miners on that gateway disconnect (there is **no edge
  buffer** by design — the edge holds no state) → region goes `stale` then `offline` → bring it
  back and miners reconnect. Nothing to reconcile, because nothing was staged.
- Re-pair drill: `remove-peer` then `add-peer` (never a duplicate add) — and confirm the region
  keeps its port when only the gateway **box** is replaced.

**Layer 4 — frontend / public**
- Public pages render live: home stats, `/blocks`, `/payments` (aggregated), `/miners` (masked
  addresses), an account page for a real address, the connect grid showing every active region.
- Admin: login over HTTPS sets httpOnly cookies; dashboard/withdrawals/settings/Regions load;
  testnet currency label shows `tGRIN`.
- XSS: a worker name / address with HTML metacharacters renders escaped.

**Failure drills (must all degrade safely):** tunnel down (above) · node stratum down (*Miners connect
but get no work*, §7) · wallet locked (*GetWorks = 0*, §7) · DB `PRAGMA integrity_check` not `ok` ·
`systemctl stop` flushes WAL cleanly (no `-wal`/`-shm` growth after stop).

### 8.5 Endpoint reality check — verified against `back-end-pool/index.js` (2026-09-07)

| Endpoint | State | Notes for testing |
|---|---|---|
| `GET /api/health` | ✅ alias of `/health` | either path works |
| `GET /api/pool/stats/regions` | ✅ | per-region GPS/miners/shares over a 15-min window, joined onto `pool_locations` |
| `GET /api/pool/locations` | ✅ | public list of active regions (region/label/stratum_url, grouped by country) |
| `GET /api/admin/health/gateways` | ✅ | per-region liveness: `min(share age, wg handshake age)` → online (<180 s) / stale / offline (≥600 s) / `unknown` when neither signal exists, plus a 2.5 s TCP probe of each declared public stratum URL |
| `GET/POST/DELETE /api/admin/locations` | ✅ | CRUD on `pool_locations` (upsert by `region`); audit-logged. **Metadata only** — the real wiring is the wg peer + region port |
| `GET /api/admin/gateways/server`, `POST /api/admin/gateways/server`, `GET /api/admin/gateways/:region/pairing` | ✅ | panel-side `init-server` / pairing-string retrieval via scoped `sudo grin-gateway-ctl`; the POST is `freshAdmin` (step-up gated) |
| `POST /api/shares`, `POST /api/blocks` | 🗑 **gone** | the satellite ingestion API. Removed 2026-06-22 with the role; there is no shared-secret header and no IP allowlist any more. A gateway sends **stratum bytes over a tunnel**, not HTTP. |
| `GET /api/admin/health/satellites` | 🗑 **gone** | replaced by `/api/admin/health/gateways` |
| `POST /api/account/:addr/withdraw` | ✅ (tor · slatepack · nostr) | `{ amount, method, proof }`; CAS lock in `WithdrawalScheduler`; 409 insufficient / 429 already-pending (any rail) / 400 below min |
| `GET /api/account/:addr` · `/balance/log` · `/shares` · `/tor-check` | ✅ | summary (balance/paid/pending/shares/hashrate, `payouts_frozen`, `has_recorded_ip`/`has_recorded_pass`), append-only ledger, Tor reachability (tri-state; `?fresh=1` re-probes past a 10 s floor — §10.5) |
| testnet `POST /api/admin/miners/:addr/inject` | ✅ testnet-only (403 on mainnet) | the "skip the maturity wait" shortcut; credits balance + writes `balance_log` + audit row |
| `POST /api/account/:addr/min-payout` | 🗑 **gone** | per-account threshold retired 2026-07-17 (§10); only pool-wide `min_withdrawal` applies |
| `POST /api/account/:addr/cancel` (public cancel) | 🗑 **gone** | removed 2026-07-17 (§10.1) — both parked states self-recover; admin cancel is step-up gated |
| `GET/POST /api/claim/:id` (slatepack claim rail) | ❌ never built | the slatepack rail ships through the withdraw route, not a claim endpoint |
| `GET/PUT /api/admin/users[/:id]`, `PUT /api/admin/miners/:addr` | ❌ still absent | legacy `admin-panel/users.html` references some; not required by the primary dashboard |
| `GET /api/admin/health/system` | ✅ | real host CPU/mem/disk/uptime |

### 8.6 Copy-paste smoke tests

Run on the box. Set the vars once. `$NET=mainnet` or `testnet`; ports per §11.

```bash
# ── vars ──────────────────────────────────────────────────────────────────────
NET=testnet                        # or mainnet
API=127.0.0.1:8090                 # Central API, local to the pool box (mainnet: 8080)
CONF=/opt/grin/conf/grin_pubpool_testnet.json      # mainnet: grin_pubpool.json
DB=/opt/grin/pubpool/$NET/pool.db
ADDR=tgrin1exampleaddressxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
ADMIN_USER=admin; ADMIN_PASS='your-admin-password'

# ── ports listening (pool box: API + public stratum + region ports on the wg IP) ─
ss -tlnp | grep -E ':(3333|13333|3416|13416|8080|8090|3391|13391|443)\b'
ss -ulnp | grep -E ':5182[01]\b'                    # WireGuard (mainnet 51820 / testnet 51821)

# ── 1) health + public reads (no auth) ─────────────────────────────────────────
curl -s http://$API/health                  # /health and /api/health both work
curl -s http://$API/api/config/pool-info
curl -s http://$API/api/pool/stats
curl -s http://$API/api/pool/stats/regions   # per-region GPS/miners/shares
curl -s http://$API/api/pool/locations       # operator-declared active regions
curl -s http://$API/api/stratum/stats
curl -s http://$API/api/stratum/hashrate
curl -s http://$API/api/pool/blocks
curl -s http://$API/api/pool/miners           # balance distribution — addresses MASKED since 2026-07-28
curl -s http://$API/api/pool/payments
# REMOVED 2026-07-28: /api/miners/top (public rich-list, see security audit §C1) and
# /api/account/$ADDR/balance (every field of it is already in /api/account/$ADDR).
curl -s http://$API/api/pool/poolstats        # pool-directory listing feed (see 1c below)
curl -s http://$API/api/public/branding
curl -s http://$API/api/public/endpoints      # the live API reference api-docs.html renders
curl -s http://$API/api/account/$ADDR        # summary (404 until the addr has shares)
curl -s http://$API/api/account/$ADDR/balance/log
curl -s http://$API/api/account/$ADDR/shares
curl -s http://$API/api/account/$ADDR/tor-check           # 60 s cache; can take ~30 s cold
curl -s "http://$API/api/account/$ADDR/tor-check?fresh=1" # re-probe (answers <10 s old are served as-is)
# online: true = a wallet answered · false = our tor works, the wallet did not · null = OUR tor
# could not look (a Tor payout is still allowed). `reason` names which — impl §10.5.

# ── 1c) Getting listed on miningpoolstats.stream/grin ───────────────────────────
# The pool is listed by PULL, not push: they poll a URL, we publish one. Hand them
#     https://<your-pool-domain>/api/pool/poolstats
# and nothing else — no file to generate, no cron, no auth carve-out (it is aggregates only,
# so it is safe unauthenticated). Listings are added by a human at MPS on request; there is no
# auto-discovery, so publishing the URL alone gets you nothing until you contact them.
#
# WHY THE SHAPE LOOKS LIKE THE SOLO FEED: it is a field-for-field mirror of solo's
# poolstats_<net>.json (scripts/lib/07_mining_block_collector.py build_poolstats). If MPS has
# already imported the solo feed, they have a working parser and need no new adapter. Adding
# fields is safe; renaming or dropping one breaks their importer. Two fields are additive-only
# extras here: pool.url and pool.reward_model.
#
# REFRESH: recomputed at most once per 60s and served from an in-process cache in between, so
# polling faster than 1/min returns byte-identical output. 1–5 min is the sensible poll range.
# (Solo's file is regenerated every 5 min by cron, so the pool feed is the fresher of the two.)
# The `ts` field is the generation time — if it stops advancing, the feed is stale.
# On a backend error the last good body is served for up to 15 min, then the endpoint 500s
# rather than serving a frozen feed forever: a listing that silently stops updating is worse
# than one that visibly goes down, because nobody notices the first.
#
# NULL vs 0 — do not treat them the same: network.* is null when the node is unreachable, and
# network.hashrate_gps_24h stays null until pool_metrics_hourly has an hour of samples (it does
# not backfill). pool.last_block is null until the pool finds its first non-orphaned block.
curl -s https://$DOMAIN/api/pool/poolstats | python3 -m json.tool
# Sanity before sending the URL: net matches the network you think you deployed, pool.name is
# not still the default, and pool.url is set (it comes from config.subdomain — blank if the
# installer never recorded a domain, which makes the listing link nowhere).

# ── 1b) API reference contract (api-docs.html) ──────────────────────────────────
# The endpoint LIST is derived from the live Express route table, so it cannot drift: a new
# route under PUBLIC_API_PREFIXES appears by itself, a deleted one disappears. The per-endpoint
# NOTES are hand-maintained in API_DOC_META and CAN drift. When you add a public route, add its
# meta entry in the same commit — desc + shape at minimum. `shape` is not decoration: this API
# is NOT uniform (newer /api/public/* routes return { success, data }, most older ones return
# the payload raw or as a bare array, and errors are ALWAYS { error } with no success flag), and
# the page publishes the real shape per row rather than one blanket claim that is wrong for most
# of them.
#
# Drift check — runs on the SOURCE, so it needs no server and works before you deploy. Fails if a
# public route has no meta entry, or a meta entry names a route that no longer exists. The meta
# regex is LINE-ANCHORED (^\s*'KEY':) on purpose: unanchored it also matched "POST /api/account"
# inside a description that cross-references another route and reported a dead entry that did
# not exist (2026-09-21). It checks KEYS only — the notes on each row are still read by hand,
# and that hand-read is what found a route labelled `raw` that returns a bare array, a body line
# that named one proof where the handler demands two, and an endpoint that had always answered `{}`.
node -e '
const src=require("fs").readFileSync("index.js","utf8");
const pf=src.slice(src.indexOf("const PUBLIC_API_PREFIXES = ["));
const P=[...pf.slice(0,pf.indexOf("];")).matchAll(/.(\/api\/[^"'"'"']+)./g)].map(m=>m[1]);
const R=[...src.matchAll(/app\.(get|post|put|delete|patch)\(\s*.([^"'"'"']+)./g)]
  .map(m=>m[1].toUpperCase()+" "+m[2]).filter(k=>P.some(p=>k.split(" ")[1].startsWith(p)));
const b=src.slice(src.indexOf("const API_DOC_META = {"));
const M=new Set([...b.slice(0,b.indexOf("\n  };")).matchAll(/^\s*.((?:GET|POST|PUT|DELETE|PATCH) \/api\/[^"'"'"']+).:/gm)].map(m=>m[1]));
const miss=R.filter(k=>!M.has(k)), dead=[...M].filter(k=>!R.includes(k));
console.log("routes",R.length,"meta",M.size,"| undocumented",miss.length,miss,"| dead",dead.length,dead);
process.exit(miss.length||dead.length?1:0);'

curl -s http://$API/api/public/endpoints | python3 -m json.tool | head -40

# ── 2) admin auth (httpOnly cookies) ────────────────────────────────────────────
curl -s -c /tmp/pool-cookies.txt -X POST http://$API/api/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASS\"}"
C='-b /tmp/pool-cookies.txt'
curl -s $C http://$API/api/admin/dashboard
curl -s $C http://$API/api/admin/audit-log            # expect a login_success row
curl -s $C http://$API/api/admin/health/system        # real CPU/mem/disk/uptime
curl -s $C http://$API/api/admin/health/gateways      # per-region liveness (see §8.5)
curl -s $C http://$API/api/admin/miners
curl -s $C "http://$API/api/admin/miners/$ADDR"
# region registry CRUD (upsert → list → the public surface reflects it)
curl -s $C -X POST http://$API/api/admin/locations -H 'Content-Type: application/json' \
  -d '{"region":"us-east","label":"US East","stratum_url":"us.example.com:3333","is_active":true}'
curl -s $C http://$API/api/admin/locations

# ── 2b) testnet-only: inject balance + drive a withdrawal end-to-end ─────────────
# inject is hard-guarded to testnet (403 on mainnet) — skips the confirm_depth wait.
curl -s $C -X POST "http://$API/api/admin/miners/$ADDR/inject" \
  -H 'Content-Type: application/json' -d '{"amount":25}'
# now the address has balance → trigger a payout. `proof` is the ownership gate (§10):
# any mining IP *or* stratum password in this address's proof set (up to 10 of each, §10.4).
curl -s -X POST "http://$API/api/account/$ADDR/withdraw" \
  -H 'Content-Type: application/json' \
  -d '{"amount":10,"method":"tor","proof":"203.0.113.9"}'
# CAS guards: a second concurrent request → 429 (pending on ANY rail); over-balance → 409
curl -s $C http://$API/api/admin/withdrawals       # the new withdrawal should appear

# ── 3) DB-layer checks (cross-check the region aggregates) ──────────────────────
sqlite3 "$DB" 'PRAGMA integrity_check;'
sqlite3 "$DB" "SELECT region,COUNT(*) FROM shares GROUP BY region;"   # matches /api/pool/stats/regions
sqlite3 "$DB" 'SELECT grin_address,balance,balance_locked FROM miner_accounts LIMIT 5;'
sqlite3 "$DB" 'SELECT height,status,found_by FROM blocks ORDER BY height DESC LIMIT 5;'
sqlite3 "$DB" "SELECT event_type,reference_type,amount FROM balance_log ORDER BY id DESC LIMIT 5;"

# ── 4) multi-region: central side ──────────────────────────────────────────────
sudo grin-gateway-ctl list   --net $NET | python3 -m json.tool   # regions + pairing strings
sudo grin-gateway-ctl status --net $NET | python3 -m json.tool   # per-region handshake + rx/tx
wg show wg-grinpool          # testnet: wg-grinpool-tn
python3 -c "import json;print(json.load(open('$CONF')).get('region_ports'))"

# ── 5) multi-region: gateway side (on the GATEWAY box) ─────────────────────────
systemctl is-active grin-gateway
journalctl -u grin-gateway -n 30 --no-pager
wg show wg-grinpool latest-handshakes           # a handshake proves the tunnel, NOT the routing
python3 -c "import json;print(json.load(open('/opt/grin/conf/grin_gateway.json')))"
# raw stratum login straight down the tunnel — proves hub_endpoint points at the RIGHT port
printf '{"id":"1","jsonrpc":"2.0","method":"login","params":{"login":"%s","pass":"x","agent":"nc"}}\n' "$ADDR" \
  | nc -w 5 <hub_tunnel_ip> <region_port>

# ── logs ─────────────────────────────────────────────────────────────────────
journalctl -u grin-pool-manager${NET:+-$NET} -n 50 --no-pager
```

> Payouts can't be smoke-tested by a single curl beyond creation (the rest is scheduler-driven and
> needs a matured block + a reachable miner listener). Validate during the 7-day soak: confirm a real
> block, wait `confirm_depth`, request a payout, watch the row reach `confirmed` with a `txid` and a
> kernel proof, then verify the reversal/CAS branches per Layer 2.

### 8.7 Hub move (Migrate OUT / IN) + connect-page latency — as built (2026-09-23, uncommitted, NOT VPS-tested)

Built in seven parts on 2026-09-23 for the move of the mainnet hub from New York to OVH Gravelines.
The *why* — effective latency, the F1/F2/F3/F4 traps, the step order — is design §4 and §13.13.
**Nothing here has run on a VPS.** The adversarial review ran the same day (audit Status roll-up,
"Part 9 review"): seven fixes (six on 2026-09-23, P1 on 2026-09-24), listed under *Part 9 review
fixes* at the end of this section.
`npm test` 960 (16 suites) → **1133 (19 suites)**, re-run 1133/1133 by the doc-fold session.

#### Files

| File | New / changed | What |
|---|---|---|
| `scripts/lib/07_lib_pool_migrate.sh` | NEW (`pmg_`) | Migrate OUT + Migrate IN. Sourced at the END of `07_lib_pool_backup.sh`, so the pool script does not source it itself. |
| `scripts/lib/07_lib_pool_backup.sh` | changed | shared cores: `pbk_freeze_payouts <db> <reason> <by>` (restore + both migrate halves), `_pbk_build_archive <strict>` (Backup now = lenient, migrate = strict), `_pbk_restore_extract` + `_pbk_restore_perms`, `_pbk_cert_paths` behind `PBK_INCLUDE_CERTS` (a global `0`, raised by a `local` in `pmg_migrate_out` only). Header, runbook and menu line rewritten to the three reconnect cases. Part 9: `_pbk_code_excludes` (never archive or extract `index.js`/`package*.json`), `_pbk_make_tar` rc 2 = pool.db not in the archive (fatal in both modes; the cron wrapper exits 1), `PBK_EXTRACT_FROZEN` + a freeze on a failed extraction. |
| `scripts/lib/07_lib_gateway.sh` | changed | `gw_install_reresolve` / `gw_remove_reresolve`; menu `6) Latency probe` (`gw_render_probe`, `gw_probe_remove`, enable / renew / disable); `gw_status` Re-resolve + Probe lines; shared `_gw_fw_open_tcp` and `_gw_haproxy_account` (the forwarder cfg renders byte-identical to before). |
| `scripts/07_grin_mining_public_pool.sh` | changed | `_pool_pairing_ip_warning` under the three CLI `GRINGW1` prints; `_pool_nginx_ping_block`, `_pool_latency_probe_domain`, `_pool_latency_hub_host`; page CSP `connect-src` + `https://*.<probe_domain>`; optional `latency_hub_url` cert + server block in `pool_setup_nginx`. Cleanup 3b also removes the re-resolve timer and the probe. |
| `back-end-pool/lib/db.js` | changed | `SEED_VERSION = 3` (`hkg`, `sin`, `cqf`); `ensureLocalRegion` stamps/reads `pool_config` `_state`/`local_region`. |
| `back-end-pool/lib/region-rtt.js` | NEW, pure | rolling window (last 5 successful) → `hub_rtt_ms` = min, integer; `0` for the hub row; `null` with no sample. |
| `back-end-pool/lib/connect-suggest.js` | NEW, pure | `estimate()` + `pickRecommended()`; `DEFAULT_K = 0.015` ms/km, `DEFAULT_DIRECT_BIAS_MS = 15`. |
| `back-end-pool/lib/latency-probe.js` | NEW, pure | `probeDomain`, `hubHost`, `latencyConfig`; `HOST_RE` = the shell's `_POOL_HOST_RE`, pinned by a test. |
| `back-end-pool/index.js` | changed | `publicRegionStatus()` lifted to module level (shared by `/stats/regions` and suggest); `probeStratumTcp` clock restarts on `lookup`/`connectionAttempt` (excludes DNS and dead IPv6 tries — also lowers the admin `stratum_probe_ms` slightly); the suggest route; `connection.latency` on branding; `API_DOC_META` rows. |
| `public_html/js/reactor-dashboard.js`, `css/reactor.css` | changed | suggestion badge, `~NN ms` estimates, browser measurement, Re-test control. |
| `scripts/test-regions.js`, `test-connect-suggest.js`, `test-latency-probe.js` | NEW | wired into `test:unit`. |

#### Menu keys

- **Pool `B` (backup):** `6) Migrate OUT` (this hub → a new box), `7) Migrate IN` (new box; offers
  `CHECK` for read-only box checks, or `MIGRATE`). Both dispatch `|| true`.
- **Gateway:** `3) Bring up tunnel` now also installs and enables the re-resolve timer (non-fatal
  if that fails). `6) Latency probe` → `1` enable / change host · `2` renew now (a staging
  `--dry-run` first; then `--force-renewal` on `y` — Let's Encrypt allows 5 per week) · `3` disable.
- **Hub `W → 5`** is unchanged, but now matters for every move: with it empty, the CLI prints a
  warning under each pairing string.

#### Config keys

| Key | Where | Meaning |
|---|---|---|
| `probe_host` | gateway `grin_gateway.json` | the probe's DNS name (its A record must be this box or its ipify public IP) |
| `probe_enabled` | gateway `grin_gateway.json` | `"1"` / `"0"` |
| `latency_probe_domain` | hub `pool.json`, optional | the domain whose subdomains the page may time. Default = the pool's `subdomain`, **never derived wider**; an override is honoured only if it equals the subdomain or is a parent of it (`pool.x.com` → `x.com`). |
| `latency_hub_url` | hub `pool.json`, optional | `https://<host>[/ping]` under the probe domain, not the site's own name or `www`, no port/query. For a hub behind a CDN: a DNS-only name that gets its own cert and a `/ping`-only server block. Unset + CDN → the hub is not timed (keeps its estimate). |
| `wg_endpoint_host` | hub `pool.json` (existing, `W → 5`) | a DNS name here is what makes a hub IP change automatic for gateways |
| `_state` / `local_region` | `pool_config` table in `pool.db` | the local region this DB last ran as (F3 stamp). Not operator-edited. |

#### Endpoints

- **`GET /api/pool/stats/regions`** — each row gains `is_hub` (bool; true on the `singlebox`'s own
  region — a `hub` role has no such row) and `hub_rtt_ms` (int ms; `0` on the hub row; `null`
  until a first successful probe).
- **`GET /api/pool/connect/suggest`** — public limiter, `Cache-Control: private, no-store`. Answers
  `{ basis: 'estimate', recommended, estimates: [{ region, est_ms, via: 'direct'|'gateway' }] }`,
  or `{ basis: 'unavailable' }` alone when there is no geo-IP, no country or no centroid. No log,
  no write; neither the IP nor the country is echoed. 500 → `{ error: 'Failed to build a suggestion' }`.
- **`GET /api/public/branding`** → `data.connection.latency = { probe_domain, hub_url, direct_bias_ms }`.
  `hub_url` is `'/ping'` (same origin), `'https://host/ping'`, or `null` (do not time direct).
  No latency object → the page measures nothing.
- **`/ping`** — hub: a location in the main vhost (and in the optional `latency_hub_url` block,
  which 404s everything else); gateway: the `grin-gateway-probe` HAProxy. Both: empty **204** to
  `GET`/`HEAD` (+ `OPTIONS` on the gateway), any query string allowed, `ACAO *`,
  `Timing-Allow-Origin *`, `Cache-Control: no-store`, no access log. Rate limits: hub `_static`
  zone burst 20; gateway 30 requests / 10 s per IP, then 429.

#### Files on the boxes

- **Gateway:** `/usr/local/bin/grin-gateway-reresolve`, `/etc/systemd/system/grin-gateway-reresolve.{service,timer}`
  (OnBootSec 2 min, every 60 s, AccuracySec 5 s; root, `CapabilityBoundingSet=CAP_NET_ADMIN`,
  `ProtectSystem=strict`, deliberately **no** `PrivateNetwork`/`PrivateDevices`). Probe:
  `/opt/grin/gateway/probe.cfg`, `/opt/grin/gateway/probe.pem` (0600 root — HAProxy loads it before
  dropping root), unit `grin-gateway-probe`, certbot deploy hook
  `/etc/letsencrypt/renewal-hooks/deploy/grin-gateway-probe.sh` (acts on its own lineage only,
  `try-restart`s the probe, never the forwarder). Logs: `journalctl -t grin-gateway-reresolve`
  (one line only when the endpoint changed).
- **Hub:** `$POOL_APP_DIR/migration_manifest.json` (0600 grinpool; renamed
  `migration_manifest.applied-<UTC>.json` by IN once the pool starts); the archive
  `/opt/grin/backups/grin_<product>_backup_<DDMMYYYY>.tar.gz.enc` (local date) + `<archive>.sha256`.

#### Migration manifest (schema 1)

`kind`, `created_at`/`created_at_unix`, `net`, `product` (`pubpool`/`pubpooltestnet`),
`archive_name`, `source{hostname, public_ip, mode}`, `pool{domain, stratum_port, local_region,
local_region_stamp, local_region_row{stratum_url, is_active}, cloudflare_proxy}`,
`wireguard{iface, listen_port, endpoint_host}`, `node{height}`, `wallet{ok, error, height,
refreshed_from_node, total, awaiting_confirmation, awaiting_finalization, immature, locked,
spendable}` (amounts are strings as grin-wallet printed them), `wallet_identity`,
`ledger{accounts{count, balance_sum, balance_locked_sum}, shares{count, max_id, latest_at},
blocks{count, max_id}, withdrawals{count, max_id, in_flight_count, in_flight_amount},
balance_log{count, max_id}}` plus **per-row sha256 digests** of accounts, blocks, withdrawals and
balance_log (explicit columns, never `SELECT *`), `in_flight_statuses{sql, source}`,
`payout_control{before, after}`, `certs_included`.
- `local_region_stamp: null` → IN writes the old tag as the stamp itself (design §13.13.2).
- `archive_name` is computed one step before the archive: a run straddling local midnight differs
  by one day. Treat ±1 day as a warning.
- IN compares with the **manifest's** in-flight SQL, and a figure absent from the manifest is
  `skip`, never `ok`.

#### Operator runbook — the move

*Days before*
1. Deploy the new code to the old hub, the new box and every gateway. On each gateway run
   `3) Bring up tunnel` once (installs the re-resolve timer). On the hub, `W → 5` = a DNS name;
   re-pair any gateway still on a raw IP (its `5) Status` warns).
2. TTL 60 s on every record that will move, ≥ 48 h ahead.
3. New box: Script 01 node, synced → pool `1) Install` **only** (never `5)` wallet) →
   `grin-secret-sync` → restart the node, let it sync → open 80/443/3333 tcp + 51820 udp.
4. New box: `B → 7` → `CHECK` until READY. Have the personal backup key to hand.

*Cutover (a low-hashrate hour. Migrate OUT turns the weekly VACUUM cron off and refuses while a
vacuum runs — its EXIT trap restarts a pool it stopped, review P1 — so a Sunday 03:00 UTC start only
costs a wait)*

5. **Old hub:** `B → 6` → `MIGRATE` (+ `PROCEED` if withdrawals are in flight) → push to
   `root@<new>` → note the sha256.
6. **New box:** `B → 7` → `MIGRATE` → Enter (the `[migration]` archive) → key → `RESTORE` → `y` and
   the new location (for Gravelines: `cqf` / Gravelines / France / FR / `50.98,2.13`) → continuity
   all ✓ → start.
7. Change exactly the DNS records it lists.
8. Watch until every gateway is ✓. A raw-IP gateway: `2) Configure` the new endpoint, then `3)`.

*After*

9. Admin → Regions: the new region active; the old one deactivated or re-pointed.
10. Reconcile clean → **unfreeze in admin → Payouts** (IN never unfreezes) → one small payout per rail.
11. Copy the migration archive off-box first — the next `B → 3` daily backup **replaces** today's
    archive of the same name — then `B → 4 → 1` key, `B → 3` daily.
12. Keep the old box dark ~7 days, then wipe it (seed + WG key). It may be rebuilt as the `nyc`
    gateway; its seeded row is untouched.

**Rollback** (printed by both halves) is valid only until the new hub accepts a share or pays:
`systemctl enable --now wg-quick@<iface>`, `env SHELL=/bin/bash <wallet dir>/pool-wallet-boot.sh`,
`systemctl enable --now <pool service>`, then pool menu `5) → 6) e` + `7) i`, `B → 3`; reconcile,
then resume in admin → Payouts.

**Expected miner downtime — an estimate, never measured:** ~15–30 min (OUT 3–8 + IN 5–12 + DNS 1–5
at TTL 60; gateways +2–3 min after DNS). The testnet rehearsal must measure it.

#### Smoke tests (latency)

```bash
# Hub /ping (same origin) — expect 204, ACAO *, Timing-Allow-Origin *, no-store
curl -sI "https://$POOL_DOMAIN/ping"
# Gateway probe (after 6) → 1) — expect 204; POST → 404; > 30 req / 10 s → 429
curl -sI "https://hkg.$POOL_DOMAIN/ping"
# Regions carry is_hub + hub_rtt_ms; suggest answers an estimate (or basis:unavailable without geo-IP)
curl -s "https://$POOL_DOMAIN/api/pool/stats/regions" | python3 -m json.tool | grep -E '"(region|is_hub|hub_rtt_ms)"'
curl -s "https://$POOL_DOMAIN/api/pool/connect/suggest"
# Gateway: re-resolve timer present and quiet
systemctl list-timers grin-gateway-reresolve.timer; journalctl -t grin-gateway-reresolve -n 20
```

#### How it was tested (locally — no VPS)

Unit suites: `test-regions.js` (seeds v3, the F3 stamp, `hub_rtt_ms`), `test-connect-suggest.js`
(calibration, effective latency, the bias, exclusions, the in-country floor, the route text, and the
page's copy of `pickRecommended` run against the lib on 2,000 generated cases),
`test-latency-probe.js` (probe domain never wider, hub host forms, the branding key set, and the
shell's CSP / named-location / cert-gated block text). Each carries revert-proofs recorded by its
build session. The bash halves and the browser were tested in throwaway harnesses outside the repo:
fake `wg`/`systemctl`/`certbot`/… on PATH through the real libs, a WSL run with **real nginx 1.24
and HAProxy 2.8** for the `/ping` blocks, a Migrate OUT → wipe → Migrate IN run on a fixture
(19 scenarios, incl. a swapped-balances case that sums alone would pass), and headless Chrome for
the connect page (estimate → measured, CDN hub, dead gateway, sessionStorage blocked, 390 px).
**None of this proves a real systemd, a real certbot issue, a real DNS flip or a real move** — that
is the VPS acceptance still owed.

#### Part 9 review fixes (2026-09-23, uncommitted, NOT VPS-tested)

The findings table and the plausible items are in the audit Status roll-up ("Part 9 review"). What
changed in the code:

| # | Where | Change |
|---|---|---|
| C1 | `_pmg_out_manifest` / `_pmg_out_archive` | `PMG_MANIFEST_ARCHIVE` holds the name the manifest promised; if the built archive's name differs (local midnight between steps 5 and 6), the manifest is rewritten and the archive rebuilt once, to the same file name. A second mismatch fails step 6. |
| C2 | `_pmg_in_restore` | `systemctl disable $POOL_SERVICE` before `_pbk_restore_extract`; refuses (nothing restored) if the unit is still enabled. Step 7 enables it as before. |
| C3 | `_pbk_code_excludes` (new), `_pbk_make_tar`, `_pbk_restore_extract`, the cron wrapper | `index.js`, `package.json`, `package-lock.json` at the top of the app dir are never archived and never extracted. |
| C4 | `_pbk_restore_extract`, `pbk_restore`, `_pmg_in_restore` | a failed extraction freezes whatever pool.db is in place (same reason/by as the caller's), `PBK_EXTRACT_FROZEN` = 1/0 on every path; `2) Restore` prints frozen / NOT frozen and runs `_pbk_restore_perms`; IN's inline freeze removed. |
| C5 | `_pbk_make_tar`, `_pbk_build_archive`, the cron wrapper | pool.db present but not staged / snapshotted / appended → `_pbk_make_tar` rc 2, which `_pbk_build_archive` treats as fatal in BOTH modes (nothing encrypted); the wrapper's `dbfail` logs `ERROR … no archive written` and exits 1. |
| C6 | `_pmg_tcp_probe`, `_pmg_https_probe`, `_pmg_in_dark_probe` | TCP: rc 1 only on `Connection refused` (stderr read under `LC_ALL=C`), everything else but a connect is rc 2. HTTPS: rc 1 only when an HTTP status came back and it is not a parsed `status: ok`; curl failing to connect / TLS / empty reply is rc 2. No domain in the manifest → the API leg is rc 2. Dark = both rc 1. |

**Verified (locally, Git-bash — no VPS):** the Part 4 harness extended with scenarios `midnight`,
`filtered` (no-route stratum + no HTTP on 443), `nohttp` (RST + no HTTP), `restorefail`, `infail`,
`nodb`, and new assertions on `happy`/`restore`/`wallet`/`swap`/`restart` (fixture now models
`1) Install` enabling the unit and a newer checkout on the new box). **Red first:** 14 of the new
assertions failed on the unfixed code. **After:** 126/126 across 25 scenarios (the original 91
across 19 still pass). Daily cron wrapper rendered through the real lib and run with a fake PATH:
6/6 (normal archive carries pool.db and no `index.js`; a failed snapshot stage writes nothing and
logs `ERROR`); `bash -n` on the rendered wrapper. Part 3's Migrate OUT harness (7 scenarios):
same exit codes, and the recorded effect order byte-identical to before the fixes. `npm test`
1133 → 1133 (19 suites; no JS changed).

**P1, 2026-09-24** (`_pmg_out_stop`, plus `PMG_VACUUM_CRON`/`PMG_VACUUM_BIN` = the pool script's
`/etc/cron.d/<service>-vacuum` and `/usr/local/bin/<service>-vacuum`): step 4 removes the weekly
VACUUM cron BEFORE anything else, then refuses (`_pmg_fail 4`, payouts stay frozen, resume = B → 6
again) while `pgrep -f` finds the vacuum script; with no `pgrep` it warns and carries on. The state
screen shows `weekly vacuum: on/off`; the rollback adds `c) Cron schedules → 2)`. Verified in Part
3's Migrate OUT harness with a fake `pgrep`: scenarios `vacuumcron` (cron removed before the stop,
move completes) and `vacuumrun` (refused before OUT's own stop, cron already gone, frozen) —
**8 of 10 new checks red on the old code, 17/17 after**, including the 7 original scenarios' call
logs byte-identical to Part 3's (archive date normalised).

---

## 9. Durable trend metrics & public chart recorders (2026-07-17, add-ons — NOT VPS-tested)

Two never-pruned hourly rollup tables (kept out of `lib/retention.js`), written by
`HashrateTracker.rollupCompletedHours()` each completed hour, idempotent upserts:

- **`pool_metrics_hourly`** — pool GPS, distinct miners, blocks, earnings, payout **+ new
  `network_hashrate_gps`** (NULL until sampled). The network sample comes from
  `hashrateTracker.networkGpsProvider` (wired in `index.js` to the block monitor's node client;
  `diff × 42 / 60 / 16384`), fetched at most once per completed hour and applied only to the
  just-completed bucket (catch-up buckets after an outage keep NULL — no fake history). Upsert
  keeps an existing sample via `COALESCE` when a re-run passes NULL. **2026-09-20: `worker_count`**
  (additive migration, NULL for hours rolled up before it) — distinct `(grin_address,
  COALESCE(worker_name,'default'))` pairs per hour, the same key `getWorkerBreakdown` groups on.
- **`pool_region_metrics_hourly`** — `(bucket_start, region)` PK: per-region GPS, distinct
  miners, share count, from the `shares.region` stamp. Backs "miners by gateway" trends.

**Endpoints** (public, rate-limited, same `?range=day|week|month|year|all` vocabulary):
- `/api/pool/metrics/history` — now also returns `network_hashrate_gps` per point (null-safe),
  and since 2026-09-20 `worker_count` (null = pre-column hour; a gap, never 0).
- `/api/pool/metrics/history/regions` (new) — `{ series: [{ region, points: [{t, miner_count,
  hashrate_gps}] }] }`, busiest-first.
- **Re-bucketing rule for counts (2026-09-20):** at day-or-coarser buckets both readers take the
  **peak hour** (`MAX`) for `miner_count`/`worker_count`, not the average. `AVG` counted every idle
  hour as zero: the first live day had 2 miners for 3 of 16 completed hours, Month/Year/All rounded
  6/16 to **0** while Day showed 2. Hashrate stays `AVG`, money stays `SUM`. The P-02 panel title
  says which it is showing (`distinct per hour` / `peak hour per day|week|month`), and P-02 now
  draws miners + workers as two lines on one count axis (`renderMultiTrendLine`), the workers line
  omitted entirely until the first hour with a recorded value.

**Frontend**
- Homepage **P-04** now stacks three Chart.js recorders (the hand-rolled 24h strip chart was
  removed; `chart.umd.min.js` + `charts-init.js` are now loaded by `index.html`): pool hashrate
  (24H = fine 5-min series from `/api/pool/hashrate/history`, 7D/30D = rollup), **network
  hashrate as an aligned small-multiple below it** (never dual-axis — network GPS is orders of
  magnitude above pool GPS), and miners online (fixed 30d). Range toggle 24H/7D/30D in the
  panel title (`.chart-range`, reactor.css). **2026-09-21:** the 24H series is gap-filled server-side
  (see §7 — a mining pause used to vanish from the trace); the hourly rollup behind 7D/30D always
  wrote zero-hours, so those ranges were already right. **2026-09-26:** P-04 opens on **30D**
  (operator request); the fine 24h series is still fetched every refresh for the dial's peak
  marker. Same day, P-06/P-07 were reported appearing minutes late. **Root cause, confirmed from
  the live hub's access log:** nginx `limit_req` 429s (162-byte nginx page, not the app's JSON) on
  the tail of each homepage batch — effort, blocks, payments and both trend reads — from single
  visitors reloading. The zone rate was the current 600r/m; the live vhost still carried the
  pre-`def8bc7` `/api/` **burst=10** (confirmed by grep of the live vhost), which admits ~11 of
  the ~19 reads a load fires. The general `/api/` burst is now **100** (40 covered only ~2 fast
  reloads; the withdraw POST keeps 40); fix on a box = re-run `4) Setup nginx`. `/api/pool/status` was
  measured at <0.13 s over 24 samples, so it was NOT the cause; the changes below are hardening
  only: the refresh no longer `await`s status before the other panels (the rods paint from their
  own feed and repaint when the height lands), `/api/pool/status` serves its last answer
  stale-while-revalidate, and `idx_withdrawal_confirmed (status, confirmed_at)` removes the full
  sort of every confirmed payout that `/api/pool/payments` ran per request. **Uncommitted, not
  VPS-tested.** Same day, **P-02b** gateway lamps read
  `2 miners / 5 workers` — `/api/pool/stats/regions` gained `workers` (distinct address+rig pairs,
  the rollup's key), withheld together with `miners` under the k-anonymity floor, plus `totals.workers`.
- **miners-stats P-02b** "Chart recorder — miners by gateway": multi-line per region via new
  `PoolCharts.renderMultiTrendLine()` (union-of-timestamps alignment, gaps NOT interpolated,
  legend for ≥2 series, single y-axis). Colors from `PoolCharts.PALETTE` — 8 fixed slots,
  CVD-validated against the dark panel surface — assigned by region NAME in alphabetical slot
  order (color follows the entity, not the rank). Panel hidden when the only region is
  `default` (single-box) or there's no data.

**Gateway status fix** (same date): `readGatewayStatus()` no longer skips WireGuard peers with
no handshake — a never-handshaked/downed gateway now yields `{handshake: 0}` so
`/api/pool/stats/regions` can mark it `offline` (red). Previously an all-gateways-down pool
returned `{}`, indistinguishable from "wg unavailable", and every dead gateway showed idle
(blue) forever.

**Public copy** (index.html): P-05 patch-note folded into the miner-setup guide (password
guidance now tells miners to pick a real private password — a future release may verify it);
P-08 vardiff line removed (no vardiff exists); payout lines now describe the miner-initiated
Tor/slatepack rails with 6h→48h retry back-off and refund-on-failure; P-03 mimic says
`SLATEPACK ▸ ON REQUEST`. Note: the stratum password is currently **not read or stored**
anywhere (`handleLogin` parses only `login`). *(Superseded later the same day — §10 makes the
password an ownership proof.)*

## 10. Ownership gate v2 + manual-withdrawal simplification (2026-07-17, add-ons — NOT VPS-tested)

> The last-2 windows described in §10–§10.1 were replaced on 2026-09-22 by a proof SET of up to
> 10 per kind with a per-address salt — §10.4 and design §17. This section is left as the 2026-07-17 record.

Operator decisions (same-day discussion): proof = IP **or** password; keep last-2 windows but
hash at rest; gate **all** money actions; retire the per-account payout threshold.

**Gate (lib/owner-proof.js, rewritten):** `verifyOwnerProof(db, addr, submitted)` takes ONE
field — if it parses as an IP (v4/v6, canonicalised) it's checked against the last-2 IP
window; a usable password is checked against the last-2 password-hash window. All proofs
stored as salted scrypt `v1$salt$hash` (never plaintext); legacy plaintext IPs upgraded by a
background `migrateOwnerProofHashes(db)` at startup (index.js calls it after scheduler start).
Trivial passwords (`x`, `123`, defaults, `d=…`, <4 chars) never capture/verify. Fail throttle
unchanged (8/10 min → 5 min lockout). `canonicalizeIp` gives IPv6 one stable form (zone/
brackets/`::ffff:`/`::`-expansion/v4-tails).

**Capture (stratum):** `handleLogin` now also reads `params.pass` → kept on the in-memory
session only; on a session's **first accepted share** `handleSubmit` calls
`minerManager.recordOwnerEvidence(addr, ip, pass)` (async fire-and-forget) which shifts the
last-2 windows for both proofs. Schema: `miner_accounts` + `last_pass_hash`/`prev_pass_hash`
(migrateMinerAccounts).

**Routes (index.js):** `POST /api/account/:addr/withdraw` (tor AND slatepack),
`…/:id/finalize`, `…/:id/cancel` all verify `req.body.proof` (legacy `ip_proof` accepted) —
rationale: an ungated Tor trigger let anyone force payouts for leaderboard addresses (pool-paid
fees, output consumption, forced timing) and an open cancel was a nuisance vector.
`POST /api/account/:addr/min-payout` **removed**; account GET no longer returns
`min_payout`/`effective_min_payout` and adds `has_recorded_pass` next to `has_recorded_ip`.
Scheduler enforces only pool-wide `config.min_withdrawal` (min_payout column now dead).

**Account page (account-settings.html):** P-04 is one column — single ownership-proof input
(hint links https://tools.grin.money/tools/my-ip/ for IPv4/IPv6 lookup), shared amount field
(blank = full balance, label shows the pool minimum), Tor/slatepack radio. Threshold UI
removed; cancel now sends the proof; friendly `PROOF_REASONS` mapping for gate errors; demo
dataset updated. Sidebar shows the pool minimum.

**Verified locally:** `node --check` on index.js + 5 libs + the extracted inline script;
owner-proof smoke test (canonicalisation v4/v6, capture/no-op/rotation, IP+password verify,
trivial-password rejection, legacy plaintext verify) — all pass. Deploy needs a backend
restart (column migration + background hash migration run automatically).

### 10.1 Same-day follow-up (2026-07-17 later, add-ons — NOT VPS-tested)

Operator decisions after a second discussion round:

- **Public cancel REMOVED** (route + P-04 button + `cancelPending`). Both parked states
  self-recover — Tor `markFailed()` auto-reverses after max retries, slatepack auto-refunds
  via TTL expiry — so cancel was pure abuse surface: a Grin send that *looks* failed may have
  actually posted, and reversing the lock then = double-pay. Admin support cases use the
  existing step-up `POST /api/admin/withdrawals/:id/cancel` (payments page);
  `scheduler.cancelWithdrawal()` kept for admin tooling only. Known residual (documented, not
  built): the automatic retry/reversal paths carry the same theoretical exposure — proper fix
  is recording slate_id on Tor sends + checking wallet tx state (`retrieve_txs`) before any
  retry/reversal.
- **Explicit amount + min/max chips**: blank-=-full-balance retired on the page (API still
  accepts `amount:null`). The amount label has clickable `min <pool-min>` / `max <balance>`
  chips that autofill; `amountValue(msgEl)` now rejects blank/non-positive with a hint.
- **Blocklist additions-only**: new `access.extra_banned_passwords` (pool_config, JSON array;
  validator accepts newline/comma lists and normalises to deduped lowercase, cap 500).
  `isUsablePassword(pass, db)` merges it (60 s cache) ON TOP of the hardcoded seed — the seed
  and structural rules can never be removed via admin. Editable in settings-access.html
  (textarea, one per line; populate special-case in settings-common.js). Because verify
  re-checks the submitted value, a newly added entry stops working as proof immediately.
- **Payout rail status chip**: account summary now returns `payouts_frozen`
  (`scheduler.isFrozen()`, boolean only — the freeze reason stays admin-side); P-04 title
  shows "payouts active/paused" chip and the Tor button disables while frozen.
- **Goblin nickname payouts over Nostr**: design only → `script07_design.md` §15 (registered
  destination + 48 h cooldown + npub TOFU pin; bridge sketch reusing the slatepack state
  machine). Not scheduled.

Verified: `node --check` ×5 + re-extracted inline script; blocklist smoke test (seed + extra
entries, case-insensitivity, corrupt-JSON fail-open) and validator normalisation tests pass.

**Round 3 (same day):** cross-rail payout exclusivity + cooldown (audit §E.2 has the full
security rationale). Shared `PENDING_SQL` in withdrawal-scheduler.js closes the hole where a
pending slatepack didn't block a Tor create (and fixes the same 3-status list in the admin
miner-detail pending view). New `_assertNoRecentReversal()` gate in both create paths:
after any withdrawal reversal (Tor failure, slatepack expiry/creation failure, admin cancel)
the address waits `payout.withdrawal_cooldown_minutes` (default 30, 0 disables) before
requesting another payout on any rail. Plumbed through pool-settings defaults/validator/
applyToConfig, config.js default, and a field on admin settings-payout.html (applied at
backend restart, like min_withdrawal); account-page note mentions the cooldown. The designed
Nostr rail (design §15) inherits both gates automatically since it parks in
`slatepack_pending`. Verified: `node --check` ×4 + 12-case stub-db smoke test (pending gate
cross-rail, cooldown default/custom/disabled, validator bounds) all pass.

### 10.2 Goblin/Nostr payout rail BUILT (2026-07-18, add-ons — NOT VPS-tested)

Full implementation of design §15 (which now carries a §15.5 "what shipped" note). A miner
registers a Goblin username on the account page and is paid over a Nostr DM — no Tor listener.
**OFF by default** (`nostr_payouts_enabled`); needs `npm install` (nostr-tools + ws) and a
backend restart. Third-party rail (pays a username, not the address's own wallet), so it
layers a registered destination + ≥48 h cooldown + TOFU npub re-pin on top of the ownership
gate — see security_audit §E.3 for the threat model.

Build shape (bottom-up):
- `lib/nostr-payout.js` — the bridge. nostr-tools + ws lazy-required inside `start()` (pool
  boots without them when the feature is off / not yet installed). All nostr-tools calls are
  confined to a "wire" section so a future API drift is a localized fix. Does NOT touch
  balances — transport only. Resolves usernames (NIP-05, domain-allowlisted), publishes the
  NIP-17 gift-wrapped slatepack, and runs a persistent subscription that routes an incoming S2
  back to the scheduler. Dedup via a `nostr_seen_events` table. Pool identity key persisted to
  a `.nostr_payout_key` file (transport-only; can't sign slates).
- `lib/withdrawal-scheduler.js` — `createNostrWithdrawal` (mirrors the slatepack rail: same
  CAS lock, `PENDING_SQL` cross-rail one-pending, freeze + failed-payout-cooldown gates, TTL
  refund; S1 is **plain armor** `recipients:[]`; publishes via the bridge, reverses the lock on
  any wallet/relay failure) and `finalizeNostrWithdrawal` (called by the bridge on an S2:
  re-checks sender==registered npub + binds slate.id — fail-closed since 2026-09-27, see §10.10
  *Slatepack finalize binding* — then finalize+post+confirm; errors leave
  the row pending for resend/TTL). `nostrBridge` injected post-construction to avoid a cycle.
- `index.js` — constructs+starts the bridge at boot inside a try/catch (missing package →
  warn + disable, never crash); wires the response handler; adds
  `POST`/`DELETE /api/account/:addr/nostr-destination` (ownership-gated, rate-limited) and a
  `method:'nostr'` branch in the withdraw route that enforces registered + cooled-down +
  TOFU-verified destination before calling the scheduler; account summary gains
  `nostr_payouts_enabled` + a `nostr_destination` state object (username + active_at, npub
  never exposed).
- Config: `lib/config.js` defaults + `lib/pool-settings.js` (defaults/validators/applyToConfig)
  for `nostr_payouts_enabled`, `nostr_relays`, `nostr_nip05_domains`,
  `nostr_destination_cooldown_hours`. Admin fields on `settings-payout.html` (+ the
  JSON-array↔newline populate special-case in `settings-common.js`). `package.json` gains
  `nostr-tools` + `ws`.
- Frontend `account-settings.html` P-04: a "Goblin (Nostr)" payout option (shown only when the
  pool enabled the rail) with a register/replace/remove destination form and a send button that
  unlocks only once the destination is past its cooldown.

Verified: `node --check` on all edited JS + the extracted account-page inline script; a
23-case stub smoke test (slatepack extraction one/none/two/oversized, relay-floor forcing +
domain allowlist parsing, all four validators, and the scheduler's createNostrWithdrawal
guards + lock/reverse-on-publish-failure + finalize sender-mismatch rejection) — all pass.
**NOT VPS-tested**: the live Nostr transport (nip59 wrap/unwrap signatures, SimplePool relay
I/O, real goblin AutoReceive round-trip) needs an E2E run against `relay.floonet.dev` with a
real Goblin wallet — do a testnet / tiny-amount pilot first.

### 10.3 Account online state is per RIG, not per address (2026-09-21, add-ons — NOT VPS-tested)

First multi-rig test: one of two workers dropped and the account page read **Status: Offline** /
**Miner offline** while the other rig kept submitting. Root cause in `lib/miners.js`:
`closeSession()` wrote `miner_accounts.is_online = 0` on EVERY session close — the flag is
per address, sessions are per rig — and nothing but the next login ever set it back. The
admin miner lists read the same column, so they showed it too.

- **Backend:** `closeSession` (and so `pruneInactiveSessions`) now drops the flag only when it
  closed the address's LAST live session (`getSessionsByMiner().length === 0`).
- **Account page:** P-05 Status and the header lamp are now one three-state readout,
  `renderOnlineState(online, total)`, driven by the same per-worker rows as the P-03 LEDs and the
  "Workers online" pill: all seen-in-24h rigs online → `Online ⛏` / `Miner online`; none →
  `Offline` / `Miner offline` (warn lamp); some → `Partial — x / y online` /
  `x of y workers online` (warn lamp). First paint uses the account flag, then the worker fetch
  refines it, so the summary can no longer disagree with the table under it. Note the two feeds
  differ on purpose: the per-rig `online` needs an accepted share (audit §J6-9), the account
  flag flips at login — a rig that just connected reads Offline until its first share lands.
- **Worker name is now what the miner typed:** `<address>.donate10` logged in as worker
  **default** — `validateUsername` stripped the `donateN` token from the label, and with nothing
  left the stand-in name applied. Nothing on screen said why, so it read as a bug. Nothing
  depended on the strip (the % travels as `parsed.donation_percent` → session → applied on the
  first accepted share; the name only groups shares), so the token is now READ and never cut:
  `.donate10` → worker `donate10`, `.rig01-donate10` → `rig01-donate10`. The literal name is
  also the one place a rig's donation is visible, which is what audit §J3-5 asked for. A name
  over the visible cap that carries a token is cut on its label part so the token stays on screen
  (the cap was 25 here, so `rig-name-that-is-long-enough-donate100` → `rig-name-that-i-donate100`,
  still 100 %; it is 32 since the Part 1 note below, which also strips the cut's trailing separator).
  Public copy on `donate.html` updated; `scripts/test-stratum-guards.js` +5 cases (59/59).

Verified locally: `node --check` on `miners.js`, `stratum-protocol.js` and the extracted inline
script; stub-DB run of two sessions on one address (close one → flag untouched, close last → 0;
prune → 0); stub-DOM run of `renderOnlineState` for 1/1, 0/1, 2/2, 1/3, 0/4; guard suite 59/59.

**Donor wall (`/api/pool/donors`, `donate.html` D-03) — same day.** Three findings from the
live-miner test, all fixed:
- `totals` were summed **after** `LIMIT 100`, so "Donors" / "Donated all-time" undercounted from
  the 101st donor on. The LIMIT moved out of the SQL (the `ORDER BY` already forces the full
  aggregate) and the cards are sliced in JS; `totals` now cover every donor.
- `active_donors` counted cards with a debit, and a donation is debited only when a block
  **matures** — a young pool reported "0 currently donating" for days with tags set. It now
  counts `miner_incentives.donation_percent > 0` directly, and the empty wall says "N miners have
  a donate tag set — the first slice is taken when the pool's next block matures".
- Both `current_percent` and `active_donors` are gated on `donationsActive()` (the predicate
  `/api/account/:addr` already used), so a pool with donations switched off shows every card
  `paused` rather than advertising cuts it is not taking.
- Copy: D-01 gained the "raise = go through `donate0` first" row (§J6-7 only lowers directly),
  and the account page's donation-row tooltip says the same. No age-out: past donors stay on
  the wall with `paused` — deliberate, a thank-you is not revoked when the giving stops.
  *(Superseded the same day by Part 4 below: the wall is a windowed league now, and a donor with
  nothing in the window moves to the capped "past donors" strip — still never deleted.)*
Verified with an in-memory stub of the three ledger tables (102 donors → 100 cards, count 102,
Σ exact; 5 live tags incl. 2 with no debit; donations off → 0 active, all badges 0).

**Part 1 (login grammar) — design §16, 2026-09-21, NOT VPS-tested.** The first of six
sessions for the donor names + league (design §16; per-session plan kept outside the repo).
`validateUsername` in `lib/stratum-protocol.js` only:
- **Worker part case-folded** — everything after the first `.` has ASCII `A-Z` folded before the
  grammar runs, so `MyBrand-donate10` logs in as worker `mybrand-donate10` at 10 % (it was refused
  at login). The address is never folded: `GRIN1…` and any mixed-case address still return null.
  ASCII-only on purpose — `toLowerCase()` maps U+212A KELVIN SIGN into the charset as `k`.
- **Limits** `MAX_WORKER_NAME_LEN` 25 → **32**, `MAX_WORKER_RAW_LEN` 40 → **48** (a 27-char brand
  clipped to `northern-hashwo-donate10`). The cut rule is unchanged — cut the label, keep the token,
  so ≥ 22 label chars survive beside `-donate100` — but the cut label now loses any trailing `-`/`_`:
  `rig-name-that-is-long-enough-donate100` → `rig-name-that-is-long-donate100`, never
  `…long--donate100`. An uncut label is byte-faithful (a typed `acme--donate10` keeps `acme-`).
- **Fourth return field `donor_label`** — `null` with no live token (a plain name, including an
  out-of-range `donate101`); `''` when the token is the whole name (`donate10` → masked address on
  the wall); else the label part **after** the cut, lowercase, which Part 2 stores as the donor name.
  The existing three fields are unchanged and stay first. `stratum-server.js` reads the result by
  field name, so nothing else moved.
- **Copy stating the old limit** fixed in place: the login error line (`stratum-server.js`, now
  "auto-shortens to 32 chars; keep it within 48"), the getting-started step on `index.html` (also
  no longer says "lowercase" as a requirement — it is applied), and five statements in the
  security audit (§J6-1, §J6-9, §J6-13, Handoffs). `donate.html` D-01 is Part 4's.
- **Tests** `scripts/test-stratum-guards.js` 61 → **71/71**: the cut expectation updated; +10 —
  uppercase worker folds, uppercase / mixed-case address refused (with and without a worker; the
  case-fold must not leak into the address), 32-char name kept whole (plain and 22 + token),
  33-char cut (both), 48 accepted / 49 refused, `_` and multi-separator strip, the three
  `donor_label` values, and the return shape (exactly four keys, existing three first).

Verified locally: `node --check` on `stratum-protocol.js`, `stratum-server.js` and the test
script; guard suite 71/71; no server started, no file left in the repo.

**Part 2 (storage + capture + the miner's own view) — design §16.3/§16.4/§16.9, 2026-09-21,
NOT VPS-tested.** Names are now captured and stored, and shown ONLY to their owner on the
account page — nothing public reads them until Part 3's moderation exists (plan ordering, not a
preference).
- **Columns** — the six `donor_*` columns from §16.3 on `miner_incentives`, in the CREATE for a
  fresh DB and via `migrateMinerIncentives()` (same add-column-if-missing pattern as
  `miner_accounts`) for an existing one; idempotent, runs on every boot.
- **`lib/donor-names.js` (new)** — the whole name model, `db` passed in, no dependency on
  `index.js` or `pool-settings.js` (the latter imports the starter list from it): `normalise`
  (lowercase, strip `-`/`_`, leet `0→o 1→i 3→e 4→a 5→s 7→t`), fixed `RESERVED` (the ten §16.4
  words + the pool name, which is applied only when it normalises to ≥ 3 chars — a two-letter
  pool name would censor everyone), `STARTER_BLOCKLIST` (51 entries, the DEFAULT of the setting),
  `matchBlocklist` (reserved first, then the operator list split on newlines — never a RegExp;
  returns the entry as typed for the admin badge), `captureDonorName` (§16.4 exactly: `''` clears,
  `admin` sticky, `allow` override, else `auto` + word or NULL; `donor_name_set_at` on every call;
  a clear also drops an `auto` verdict since it was about the name that is gone, while `admin` /
  `allow` survive as per-address decisions), `rescanAll` (walks `donor_name IS NOT NULL` rows that
  are NULL/`auto` — bounded by names, never shares; returns `scanned`, `censored` = rows in `auto`
  AFTER the scan, `cleared` = `auto` rows the new list no longer matches; re-stamps `censor_at`
  only on a change), `displayState` (the ONE function both the account API and Part 4's wall
  call — `shown | masked | censored | expired`, `name` null for everything but `shown` unless
  censored + `marker`), and `donorSettings` — the bounded reader every consumer goes through.
- **Two deltas from §16 worth knowing.** (1) Expiry counts from the LATER of the last donation
  debit and the capture itself, in calendar months (UTC): a name just set through the ceremony is
  not instantly "expired" while its first debit is still a block away, and a returning donor who
  re-runs the ceremony is fresh again. (2) Censor outranks expiry — a censored name that also
  aged out still reports `censored` (and the marker, if chosen).
- **Settings** — six keys on the `incentives` section with write-side validators (list cleaned to
  one trimmed entry per line, ≤ 64 KB / 4000 entries; display a closed enum; ints/percent/cap
  bounded) AND `donorSettings()` re-bounding every value on read (a hand-edited row, a blank or
  `"abc"` → the default, never NaN). No new booleans. `donation_address` and
  `allow_miner_donations` stay where they are; Part 3 moves them.
- **Capture site** — `stratum-server.js` parks `donor_label` on the session at login beside the
  percent; the donation-apply block moved verbatim into `_applyParkedDonation(session)` (one
  call site, same PROOF_MIN_SHARES gate at it) so the test can drive the real branch; the name
  write is `wrote && current === 0 && percent > 0` and nothing else — a LOWER, a same-value
  resend, a refused raise, a `donate0`, or a set that `setDonation` refused (donations off) never
  reach it. `_captureDonorName` reads the list + pool name fresh per capture (once per ceremony,
  never per share) and logs one line: masked address, name, censor state — never the password
  or IP.
- **`lib/donor-ledger.js` (new)** — `lastDonatedAt(db, address, H)`, the single-address form of
  the composite rollup + raw read `/api/pool/donors` uses. One home for the ledger SQL so Part 3/4
  extend it rather than fork it; no column was added for the date.
- **`/api/account/:addr`** gains `donor_name` + `donor_name_state`, behind the same
  `donationsActive()` gate as `donation_percent` (both null on a dormant pool), through
  `displayState`. `API_DOC_META` row updated. The account page's donation row now also stays
  visible for a PAUSED donor who has a name (`paused (0%)`), with a second line: *Donor name:
  acme* / *hidden by the pool — contact the operator if this is a mistake* / *expired —
  reconnect with your tag to refresh it*; `textContent`, never innerHTML; tooltip explains the
  rename ceremony. `masked` and null print nothing extra.
- **Tests** `scripts/test-donor-names.js` (new, in-memory copy of the REAL schema via
  `initDb(':memory:')`, in `npm run test:unit`): **100/100** — migration twice, normalise/leet,
  reserved (incl. pool name and its 3-char floor), list (CRLF, order, regex-special text never
  throws), the `classic ⊃ ass` false positive documented as EXPECTED, capture in every censor
  state, `''` clear semantics, rescan counts + idempotence + empty list, displayState for all four
  states × both display modes + the exact calendar boundary, bounded readers with junk input,
  validators + a store round trip, the composite ledger read across the horizon, and the stratum
  gate with a stub incentives manager (eight arms incl. the full ceremony) plus the real capture
  path with its log line. Guard suite unchanged at 71/71; admin-panel 41, public-leakage 58,
  admin-guards 65, money-path 32 all green; `check-syntax` 64 files + 29 inline blocks.

Verified locally, one-shot only (no server): `node --check` on every touched file, the suites
above, and the account page's donation-row branch driven against a stub DOM for all six states.
`git status --short` shows the three new files and nothing else untracked.

**Part 3 (admin: routes, audit, rescan, `donors.html`, settings move, dashboard count) — design
§16.5/§16.8, 2026-09-21, NOT VPS-tested.** The operator's moderation surface. Nothing public
changed: `/api/pool/donors` and `donate.html` are untouched (Part 4), and the guard suite now
pins that the public route still masks and emits no censor word/by.
- **`GET /api/admin/donors` (secureAdmin)** — one row per address that has a ledger debit, a
  live tag, **or a stored name** (a widening of §16.8's two: a miner who ran the ceremony and
  paused before the first matured block has a name on file and no debit, and moderation that
  starts after publication is the review gate §16.1 #3 rejected). FULL addresses. Per row:
  name + the six `donor_*` columns, `current_percent` (0 when donations are switched off — the
  same gate as the wall), `lifetime_donated`, `in_window_donated`, `active_months`, first/last,
  `donation_count`, `multiplier`, `score`, `rank` (league order; null with nothing in the window),
  `is_new` (captured ≤ 7 d), `renamed_while_censored` (`admin` and `set_at > censor_at`), and
  `workers` from `getWorkersForAccount(addr, 1440)` — `{name, online, tagged}`, `tagged` via
  the new `parseDonateToken()` export of `lib/stratum-protocol.js` (the login regex became a
  named constant both use; `validateUsername` is byte-for-byte the same, guard suite 71/71).
  Envelope: `count`, `window_days`, `donations_active`, `new_names_7d`, `now`; `?limit` ≤ 500.
  Cost: ONE composite ledger scan (the same UNION `/api/pool/donors` has always run) + a small
  `miner_incentives` read + per-returned-row indexed worker lookups on a table pruned to ~31 h.
- **`lib/donor-ledger.js`** grew the per-address aggregate `donorLedger(db, {H, windowDays,
  now})` (lifetime, in-window, first/last, count, **active months = `COUNT(DISTINCT
  strftime('%Y-%m', t))`** over rollup + raw) and the §16.6 helpers `loyaltyMultiplier`,
  `donorScore`, `leagueOrder` — Part 4's league imports these, so the admin list and the wall
  cannot rank differently. **Window boundary, stated once in the lib:** a rolled day is one row
  at its UTC midnight and is in the window WHOLE when that midnight is ≥ the cutoff (a 23:59
  debit on a rolled day counts by its day); raw rows compare at second precision.
- **`POST /api/admin/donors/:addr/censor` and `/uncensor` (freshAdmin)** — `:addr` through
  `GRIN_ADDR_RE` (400), then `lib/donor-names.js adminCensor()`, which is the state machine, the
  write and the `admin_audit_log` row (`donor_censor` / `donor_uncensor`, target_type `donor`,
  details `{name, previous}`, ip) in ONE transaction — fail-closed like `updateSection`. 404
  unknown address, 409 already in that state. Table: NULL/auto/allow → censor → `admin`;
  NULL/auto/admin → uncensor → `allow` (never NULL — NULL would re-arm the auto-list). A censor
  on an address with no name yet is allowed (pre-emptive, sticky); an un-censor from NULL is
  allowed (pre-emptive whitelist). The word is cleared on either — it described an auto verdict.
- **Rescan hook** in `POST /api/admin/settings/:section`: reads the list + pool name BEFORE the
  write and, when either CHANGED (not merely present — the harvester posts every key), runs
  `rescanAll` and returns `rescan: {scanned, censored, cleared}` on the response; a rescan
  failure is reported in that field and never fails a save that already landed. Renaming the
  pool triggers it too, because the pool name is a reserved word (§16.4 #2).
- **Dashboard** `new_donor_names_7d` (`countNewNames`: `donor_name IS NOT NULL AND set_at ≥
  now − 7 d`, so a cleared name is not "new") on `/api/admin/dashboard` → a sixth Overview tile
  linking to Donors; **`GET /api/admin/donors/summary`** (one COUNT) feeds the nav badge that
  `admin-shell.js decorateDonorBadge()` paints on the Donors row on every page load — painted
  only for a positive number, so a 429 body can never render "undefined". Pill ink is
  `var(--btn-text)`, the admin bundle's ink-on-accent token (`--bg` does not exist there).
- **`admin-panel/donors.html` (new)** — NAV child of Dashboard directly after Miners. Same
  shell as `miners.html` (auth gate, AdminTable with search + paging, `setRows` keeping page +
  query on the 60 s timer, `reset` only from the state select: all / named / censored / new).
  Columns per §16.8 with medals for the top 3, the state badges (`ok` · `auto: "word"` ·
  `admin-censored` · `allowed` · `NEW` · `renamed while censored`), workers as LED + name with
  the tagged rig marked 🏷 (6 shown, "+N more"), and `.btn-icon` row actions (🚫 censor / ✅
  allow, shown per state) passing the address via `data-addr`. Every name/word/worker name goes
  through `escHtml`. A non-2xx body from `API.get` renders as an ERROR row, never as "no
  donors". **Donation settings** on the same page: `allow_miner_donations` + `donation_address`
  (MOVED here — `settings-incentives.html` keeps one line linking to Donors; the moved keys exist
  on exactly one page, pinned by test), then the six donor keys with helpers, the list as a
  monospace textarea. The form is PAGE-LOCAL, not `settings-common.js`: `saveSection()` discards
  the response body and the one thing this form must show is the rescan counts. Its harvester
  follows the same three rules (bind by id; `settings-skip`; blank scalars dropped unless
  `settings-allow-empty` — `donation_address` carries it so "leave blank" persists). No merge
  step was needed: `updateSection()` upserts only the keys it is sent, so the partial form and
  the Incentives page never clobber each other. Both flash targets hide INLINE (the 2026-09-19
  rule). Writes go through `adminFetch` — `Auth.fetch` would surface a freshAdmin challenge with
  no way to complete it; a plain session on this page is the normal case.
- **Tests** — `test-donor-names.js` 100 → **148/148** (+ token parser, ledger aggregate with the
  exact day-edge in/out, window 0, junk window, below-horizon raw invisible, score/multiplier/cap
  incl. NaN/Infinity in, league order, the full censor table with audit rows, fail-closed
  rollback via a bad admin FK, new-names count at the 7-day edge); `test-admin-panel.js` 41 →
  **71/71** (page exists, NAV position, id sweep against the LIVE `PoolSettings.defaults`, moved
  keys on exactly one page, inline-hidden flash targets, `this.dataset` row buttons, adminFetch
  not Auth.read, error-vs-empty, escaping, rescan flash, the Overview tile; the sweep was
  negative-controlled with a stray hidden id); `test-admin-guards.js` 65 → **79/79** (guard tier
  per route read from the declaration — control: ban=fresh, miners=secure — address gate,
  delegation to `adminCensor`, 404/409, the rescan hook's before/after shape, public route
  unchanged, dashboard field). All 14 suites green; `npm test` exit 0.
- **A pre-existing gate bug fixed on the way — `scripts/check-syntax.js`.** Its `type=` sniff ran
  over the WHOLE `<script>` match, body included, so any inline block whose row template contains
  `type="button"` read as `type=button` → "not JavaScript" → skipped. `donors.html`, `miners.html`
  and the admin `index.html` were never syntax-checked, and a deliberately broken `donors.html`
  passed `npm run check-syntax` with "Syntax OK". Now sniffs the opening tag's attributes only:
  29 → **32** inline blocks; the negative control fails with the file named.

Verified locally, one-shot only (no server): `node --check` on every touched file; the suites
above; the page's inline script driven through a stub DOM (28 checks: hostile names/words/worker
names escaped, actions per state, filters, timer vs reset, 429-as-error, harvester rules, save +
rescan flash, refusal reasons, populate); the real `GET /api/admin/donors`, censor/uncensor,
dashboard and settings-save handlers extracted from `index.js` and run against the in-memory
schema (21 checks incl. the rescan hook firing on a list change, NOT on an unchanged list, on an
empty list, and on a pool rename). `git status --short` shows `donors.html` + Part 2's three
files and nothing else untracked.

**Part 4 (public: `/api/pool/donors` v2, D-03 league + past strip, copy, api-docs, leakage
tests) — design §16.6/§16.7/§16.9, 2026-09-21, NOT VPS-tested.** The part that makes names
visible. The admin page and the capture rule are untouched.
- **`lib/donor-ledger.js donorWall(db, {ds, now, H, active, rigsOnline, mask})`** builds the
  whole response — in the lib, not the route, because `index.js` starts a server on require and
  a route can only ever be read as text; `scripts/test-donor-league.js` runs the builder against
  the in-memory schema. Shape: `{ league: [card…], past: { donors: [card…], more }, totals,
  ranking: { window_days, loyalty_percent_per_month, loyalty_cap, name_expiry_months },
  censored_display }`. Card: `rank` (1..N, null on past) · `name` · `name_state` · `address`
  (masked) · `in_window_donated` · `total_donated` · `active_months` · `multiplier` · `score` ·
  `current_percent` · `first/last_donated_at` · `donation_count` · `rigs_online`. League =
  in-window > 0, `leagueOrder`, LIMIT 100; past = nothing in the window, most recent last
  donation first (ties: lifetime DESC, address ASC — rolled days tie by the day), LIMIT 20 +
  `more`; the two are disjoint by construction. `totals` stay lifetime over every donor; a
  donor beyond the 100th league place is on neither list but is counted (design as written).
  **The mask is a REQUIRED argument and the lib throws without one** — a wall with no mask is
  §J11-1, and `past` is exactly the second array a route would forget. Names through the SAME
  `displayState` the account API uses; no card key starts with `donor_`. Settings through
  `donorSettings()` (bounded), with a fallback to defaults when no `ds` is passed, so a blank
  or `"Infinity"` setting can never reach a multiplier (memory
  `reference_money_number_boundary_traps`). Cost: the one composite ledger scan the route has
  always run, one COUNT for `active_donors`, one IN-list read of `miner_incentives` for the
  ≤ 120 cards shown.
- **Route** — thin: reads `donationsActive()`, `donorSettings`, builds `rigs_online` in ONE
  pass over `minerManager.getActiveSessions()` (MINING sessions only, `acceptedShares > 0`,
  §J6-9 — a login is unauthenticated, so without the share bar anyone could put rigs on
  someone else's card; distinct worker names, never a shares query per card) and passes
  `mask: (a) => maskAddr(a)`. Same `public` bucket; still `raw` shape.
- **`donate.html`** — D-01: `grin1…address.donate10` now says the wall shows the masked
  address; the `rig01-donate5` row became `grin1…address.yourbrandname-donate10` with the
  donor-name sentence (lowercase, up to 32 characters; plain `donate10` = masked address); the
  panel note gained "to change your donor name, use the same ceremony as a raise" and that a
  plain `donate10` at that step removes the name. D-03 is "Donor league": a ranking sentence
  (`#donor-ranking`) rewritten from `ranking` — "in the last N days" / "all-time" for 0 — with
  a window-agnostic static fallback so a failed fetch never states a wrong number; cards per
  §16.7 (medal or `#N`, display name, GRIN in window with "in window" only when a window is
  set, lifetime only when it differs, `×1.4 loyalty · 4 months`, `donating N%` / `paused`,
  `since <day> · N rigs online`); a **past-donors strip** (`#donor-past`: name/masked +
  lifetime + last day, then "and N more past donors"); "Names are chosen by the donors and are
  not verified by the pool." at the foot of the panel; "(all times UTC)" stays once in the
  deck-head. Three empty states: no donors (tags-set message kept), donors but an empty
  window ("NO DONATIONS IN THE RANKING WINDOW YET — past donors below"), and unavailable.
  **Every name goes through `escHtml`** — the marker `<censored-donor>` contains angle
  brackets and must display literally. The read stays the page's own 2xx-only `fetch`
  (`r.ok ? r.json() : null`, the `Auth.read` contract — `auth.js` is not loaded on this page
  and `Auth.fetch` is never used). Names `word-break: break-all`; the first line of a card
  clears the absolute rank badge (`padding-right: 44px`).
- **api-docs** — the `GET /api/pool/donors` meta row rewritten for the v2 shape (league/past/
  totals/ranking, score formula, opt-in lowercase name, masked addresses, the marker only under
  `marker`, window edge). §1b drift check: 49 routes / 49 meta / 0 / 0; row hand-read against
  `donorWall()`.
- **Tests** — `scripts/test-donor-league.js` (new, in-memory, **68/68**): mask required; 102
  donors → league 100, totals 102, Σ exact, ranks 1..100; window 365 drops a 400-day donor to
  past with lifetime intact and window 0 brings it back with in_window == lifetime; the exact
  day-edge in/out; active months across rollup + raw (3), multiplier ×1.3, cap ×3 at 30 months
  and a lower cap honoured, 0 % loyalty; tie order (months DESC, first ASC); past cap 20 + more
  5, order, same-day tie-break; league/past disjoint; empty league + past; all name states in
  both display modes, expiry incl. 0 = never; leakage sweep (no `donor_censor*` /
  `donor_name_set_at` / `grin_address` key, no full address string, no censor word, no marker
  under masked); the switch gating; `rigs_online` from Map/function, NaN → 0, never ranked;
  junk/blank/Infinity settings → defaults and finite scores, JSON round trip with no
  null-from-Infinity. `scripts/test-public-leakage.js` 59 → **77/77** with §9: the route
  delegates with the mask and reads no donor column itself; the lib's card builder has no
  `donor_` key and masks via `opts.mask` only; neither `index.js` (outside the api-docs row) nor
  the ledger lib spells the marker — `displayState` is the one emitter (exactly 3 mentions in
  `donor-names.js`); `/api/account/:addr` selects three donor columns and emits two fields;
  live `displayState` checks (masked → null, marker → the string, unknown value → masked, marker
  never touches shown/masked/expired, never a `donor_` key). `test-admin-guards.js`'s Part 3 pin
  on the old inline `r.address = maskAddr(r.address)` updated to the v2 form (79/79); added to
  `npm run test:unit`. 15 suites green; `check-syntax.js` 65 files + 32 inline blocks.
- **Delta vs §16:** none in substance. Two things the design left implicit are now stated:
  the past strip's tie-break, and that a league overflow (>100 in the window) is counted in
  `totals` but shown on neither list.

Verified locally, one-shot only: `node --check` on every touched file; the suites above; the
page's inline script `vm.Script`-parsed; the **390 px iframe probe** (a throwaway Node static
server on 127.0.0.1 with stubbed `/api/*`, Chrome headless `--dump-dom`, killed in-session) on
three fixtures — full league with a 31- and a 32-char name, the marker, a 100 % badge, and a
past strip with `more` 14; past-only with an all-time window; no donors with 2 tags set —
`docWidth` 375 (= 390 − scrollbar), **0 elements past the right edge**, every state's copy
rendered as designed. `git status --short` shows `test-donor-league.js` and the Part 2/3 files
untracked and nothing else.

**Part 5 (independent review of Parts 1–4) — design §16 + §16.10, 2026-09-21, NOT VPS-tested.**
A separate cold session read the working-tree diff against §16 in the plan's nine-question order
(stranger write trace, public leakage field list, censor state table, a hand-recomputed card,
type traps, DB cost by `EXPLAIN QUERY PLAN`, panel rules, public-page rules, docs honesty). The
questions, their answers and the deltas table are **design §16.12** — the durable record; this
note is what changed in the tree.
- **Fix A (Medium) — `lib/donor-names.js rescanAll`** parsed the operator's list once per
  NAME: `matchBlocklist(name, listText, …)` re-ran `parseList` (normalising every entry) on
  every row. Measured 300 names × the 4000-entry validator ceiling = **1048 ms** per list save
  on the synchronous connection the stratum server shares — a one-second share-intake stall,
  admin-triggered. The matcher is now two layers: `matchEntries(name, entries, poolEntry)` over a
  pre-parsed list, with `matchBlocklist` the one-name convenience over it; the walk parses once
  (**16 ms**). `poolNameEntry` and `matchEntries` are exported for the test.
- **Fix B (Low) — `captureDonorName`**: a separators-only label (`--donate10` arrives as `-`,
  `_-_-donate10` as `_-_` — inside the grammar, so Part 1 hands it over as typed) passed
  `LABEL_RE`, normalised to `''`, matched nothing and was stored and shown as the name `-`. It is
  now no label (clears, like `''`); `-a-` and a lone leet digit are still names.
- **Tests** `scripts/test-donor-names.js` 148 → **156/156**: four label cases for B; for A an
  equivalence check (`matchEntries(parsed) ≡ matchBlocklist(text)` over six names incl. a
  reserved word, the pool name and a list entry), a source pin that `rescanAll` calls
  `parseList` exactly once above its row loop and the loop uses `matchEntries`, the 4000-entry
  list giving the same verdicts, and a 2 s ceiling on that walk. Every other suite unchanged; all
  16 (15 scripts + `check-syntax`) green after the fixes.
- **Docs** — design §16 heading and file header no longer say "NOT built" / "Parts 3–6 design
  only"; §16.11 Part 5 row; §16.12 added; security audit header + Status roll-up now name Parts
  2–4's new surface and that §16.12 is its only review so far; memory `project_pool_incentives`.
- **Not re-run here:** Part 4's 390 px iframe probe (documented method and fixtures above);
  nothing on a VPS.

Verified locally, one-shot only: `node --check` on the two touched files, the 16 suites, the
scratch recompute script (scratchpad, deleted). `git status --short` shows the same five
untracked files as Part 4 and nothing else.

---

### 10.4 Ownership-proof SET — backend (2026-09-22, add-ons — NOT VPS-tested)

Design contract: [`script07_design.md`](script07_design.md) §17. This is **Part 1 of five**
(backend); the account page is Part 2, the copy sweep Part 3, an independent review Part 4 and
VPS acceptance Part 5. §17.6 carries each part's state.

Replaces the **2-slot proof window** that had gated every self-service money action since
2026-07-17 (§10, audit §E/§F/§J3). The window compared a capture against its newer slot only, so
two facilities whose rigs reconnected in turn rotated it on every reconnect — re-stamping the age
the §J3-1 destination gate reads and lighting an "evidence changed" warning for honest churn.
The page's "use the same password on every rig" was a workaround for the slot count.

**Schema** (`lib/db.js`) — one new table and one new column, no `DROP COLUMN`:

```sql
CREATE TABLE IF NOT EXISTS miner_proofs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  grin_address  TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('ip','pass')),
  hash          TEXT NOT NULL,            -- 'v2$<b64>' or a carried-over 'v1$<salt>$<b64>'
  first_seen_at INTEGER DEFAULT NULL,     -- never updated on a live row; restarted when an evicted anchor returns (Part 4); NULL = migrated unknown = OLD
  last_seen_at  INTEGER NOT NULL,         -- refreshed on every match; the LRU key
  is_anchor     INTEGER NOT NULL DEFAULT 0,
  evicted_at    INTEGER DEFAULT NULL,     -- NULL = live; only an anchor is ever non-live
  UNIQUE (grin_address, kind, hash)
);
CREATE INDEX IF NOT EXISTS idx_miner_proofs_lru
  ON miner_proofs (grin_address, kind, evicted_at, last_seen_at);
-- miner_accounts + proof_salt TEXT DEFAULT NULL
```

The ten legacy columns (`last_ip`/`prev_ip`/`anchor_ip`, `last_pass_hash`/`prev_pass_hash`/
`anchor_pass_hash`, the four `*_at`) stay in the schema and are **read by exactly one function**,
the migration below. A grep for them across `web/07_mining_pool_public/` returns `lib/db.js`'s
schema and `lib/owner-proof.js`'s migration and nothing else.

**Capture / verify** (`lib/owner-proof.js`). `PROOF_SET_MAX = 10` live rows per (address, kind),
a module constant and deliberately not a setting. Per kind a capture does exactly one of:

| state | action | audit |
|---|---|---|
| value is already a LIVE row | `last_seen_at = now`. **`first_seen_at` never moves.** | none |
| the live set is EMPTY | insert; the row becomes the anchor | none |
| anything else (new value, or the evicted anchor returning) | needs `mayDisplace`; evicts LRU live rows first. A returning anchor is un-evicted with **`first_seen_at = now`** — its age restarts (Part 4, below) | `evidence_added` `{kind, live_after, evicted}` |

`evidence_displaced` is retired. Eviction is least-recently-**seen**, and an **anchor row is
flagged `evicted_at`, never deleted** — the one `DELETE FROM miner_proofs` in the codebase sits
behind `if (r.is_anchor) … else DELETE`.

`verifyOwnerProof` keeps its signature and every reason string; `slot` is now `'set' | 'anchor'`,
and **`'anchor'` only for an EVICTED anchor row** — a live anchor is an ordinary member, so an
actively-mining owner is not barred from the destination gate. `age_seconds` comes from
`first_seen_at`. **`requireBothProofs`' logic is unchanged** (Part 4 touched only its two error
strings); because a refresh never moves `first_seen_at`, the §J3-1 AND+AGE gate no longer
refuses an owner whose rigs merely reconnected. As first built, a returning evicted anchor kept its
original stamp and so became an aged, live `'set'` leg — weaker than the window, which gave a
returning value a fresh age. Part 4 restarts it (below).

**One salt per ADDRESS** (`miner_accounts.proof_salt`, 16 random bytes, base64), minted by
`getOrCreateSalt` with `UPDATE … WHERE proof_salt IS NULL` **then a re-read** — two rigs' first
shares landing together must agree on one salt, so the function never returns the value it just
generated. Rows are `v2$<hashB64>`; scrypt parameters unchanged (N=16384, r=8, p=1, 32-byte key,
16 MB). Digests compare with `crypto.timingSafeEqual`.

*Measured KDF cost per verify* (asserted by wrapping `crypto.scrypt`, not reasoned about — audit
§F2 sizes the per-IP throttle against this): **1** call on a v2-only set of any size, success or
failure, for input used as typed; **2** when the input is an IP whose canonical form differs from
what was typed and is also password-shaped (a compressed IPv6 like `2001:db8::1`: the IP set
needs the canonical spelling, the password set the raw one). Plus **one per legacy v1 row of each
kind tried** — up to 6 on a migrated account holding anchor/last/prev of both kinds — and no v2
digest at all while the account has no salt. **Transitional ceiling: 8** (2 + 6), above the old
window's 6, falling to ≤ 2 as captures rewrite v1 rows. *(As first written this paragraph said
"1 + n_v1"; Part 4 measured the 2 and the 8, and both are now asserted.)*

**Migration** — `migrateProofSet(db)`, synchronous, called **immediately before
`stratumServer.start()`** (an account reaching its first post-upgrade capture with an empty set
would anchor to whoever mined that share). As first built it sat where `backfillProofAnchors`
was — ~130 lines AFTER the listener start, behind `await nostrBridge.start()`; Part 4 moved it. `migrateOwnerProofHashes` and `backfillProofAnchors`
are **deleted**; their jobs are subsumed. Mapping: the anchor becomes an `is_anchor=1` row, live
when its stored string equals `last` or `prev` and otherwise `evicted_at = anchor_set_at`; `last`
and `prev` become live rows carrying their own `*_at` as `first_seen_at`. Rows insert anchor →
prev → last so `id` — the LRU tiebreaker when timestamps are unknown — runs oldest to newest. A
pre-v1 plaintext value is hashed with `scryptSync` **outside** the transaction.

*Idempotency proof, stated because there is no marker table (repo style):* the migration NULLs
all ten columns for every account it copied, and its `SELECT` is `WHERE <any legacy value> IS NOT
NULL`. A second run therefore selects zero rows, returns 0 and logs nothing. Asserted both ways —
the columns are NULL afterwards, and a second call inserts nothing.

**API shape.** `GET /api/account/:addr` drops the `evidence` object and gains
`proofs: { ip, pass, max, anchor, last_added_at }` — live counts per kind, the cap, whether an
anchor row exists at all, and the newest `first_seen_at` across both kinds.
`has_recorded_ip` / `has_recorded_pass` are derived from the counts (each includes its kind's
anchor, evicted or not, because an evicted anchor still verifies). `GET /api/admin/miners/:addr`
gains `proofs.{ip,pass} = { live, oldest_first_seen, newest_last_seen, anchor_live }`. **No
response body, anywhere, carries a proof value, a digest, `proof_salt` or a per-row capture
time** — `test-public-leakage.js` asserts that on both routes, on `index.js` as a whole, and on
every `console.*` line in `owner-proof.js`.

Observed live against the real `lib/db.js` schema (one-shot script, temp DB deleted): 3 IPs +
2 passwords → `{ip:3, pass:2, max:10, anchor:true, last_added_at:…}`; past the cap → `{ip:10, …}`
with the admin view reporting `anchor_live:0` for the evicted IP anchor while `proofs.anchor`
stays true; a never-mined account → all zeros, `anchor:false`, `last_added_at:null`.

**Tests** — `scripts/test-owner-gate.js` **19 → 36**, `scripts/test-public-leakage.js` **77 → 86**;
suite total **849 → 875 across 15 suites, all passing** (`npm test`, which also runs
`check-syntax`). Its `freshDb()` now builds the DB through `lib/sqlite-compat.js` rather than a
bare `node:sqlite` `DatabaseSync`: the bare one has no `.transaction()`, so a migration opening one
threw in the test and worked in production — the wrong way round for a test to be wrong. New
coverage: LRU eviction order; an anchor flagged not deleted, still verifying, still refused by the
destination gate, and refused outright under `allowAnchor:false`; re-activating an evicted anchor
gated by `mayDisplace` and not breaking the cap; three sites surviving six reconnects with
`first_seen_at` unmoved and **no audit row for a refresh**; one share creating but not adding;
the migration's mapping, column clearing and no-op second run; a v1 row verifying and being
rewritten as v2 in place; two concurrent first captures landing on ONE salt and ONE anchor; the
KDF-cost table above; and every reason string `index.js` maps.

**Not changed:** `PROOF_MIN_SHARES`, the (address, origin) lockout and its counters,
`pass_proof_state`, `getPasswordConsistency` (still live-session-based, still guarded on
`session.acceptedShares`), the withdraw/export rate buckets, `requireBothProofs`.

**Deltas from §17**, all additive:
- §17.4 asks `test-public-leakage.js` to assert the `proofs` shape and the absence of
  `proof_salt`; the Part-1 file list in the run plan did not name that file. Added here — it is
  an API-shape assertion and Parts 2/3 do not touch it.
- `_makeRoom` takes a `headroom` argument (1 for an insert, 0 for the migration's defensive
  trim). Evicting `live − max + 1` when nothing is being inserted would throw away a working
  proof for nothing.
- `is_anchor` is decided **inside** the INSERT statement via `EXISTS`, not from a snapshot read
  before the KDF. Two first captures racing through scrypt would otherwise each see an empty set
  and each claim the anchor. For the same reason `_captureProof` reads the rows **twice** — once
  to find which v1 hashes need testing, and again after the last `await`, so nothing that decides
  (live count, cap, LRU pick) is read across an await from the write that depends on it.
- `hashProof` (the v1 writer) is exported. Nothing in production writes v1 any more, but the
  regression suite needs to build a legacy row through the same code that parses one.

Verified locally, one-shot only: `node --check` on each changed `.js`, `npm test` (875/875), and
the runtime aggregate script above (scratchpad, temp DB deleted). No server was started.

#### Part 2 — account page (2026-09-22, `public_html/account-settings.html` only)

Renders what Part 1 returns. One file, no backend change, no new test.

- **On-record hint** — `proofHintText(a)`, a new function beside `renderPasswordProof`, replaces
  the two-boolean sentence with counts off `a.proofs`: *"On record for this address: 3 mining IPs
  and 2 rig passwords (up to 10 of each) · last added 2026-09-20 13:21"*. Singular/plural on both
  nouns; one count at zero names only the other kind and drops *"of each"*; `last_added_at` null
  drops the clause. Time via the page's `fmtWhen` (UTC, suffix-free — the deck head states it once).
- **Three branches, on purpose.** Counts when `proofs` is present; the old whether-not-how-many
  sentence when it is **absent** (an older backend or a cached response — a count the server did
  not send is not a fact about the account, and rendering 0 would read as "nothing recorded"); and
  a distinct line when both live counts are 0 but the write-once original survives, since that
  account *can* still reach its wallet and "No proof recorded yet" would be a lie to the one miner
  who most needs to know. That third state is reachable through the migration — an account whose
  `anchor_*` was set with both window slots empty lands as one evicted anchor row and no live row.
- **"Evidence changed" banner deleted** (design §17.2 #8), and the `evidence` argument with it —
  `renderPasswordProof(pp, proofs)` now takes the counts, because the cap is what its remaining
  warning is measured against. Neither fact is lost: *last added* is in the hint, and the "someone
  else mined to this address" explanation moved into the *Why does my rig password matter?* fold.
  *(2026-09-23: that fold was removed by the payout-rails fix; this explanation is now only an HTML
  comment above the gate label — §10.5 Part 3.)*
- **Password diagnostics.** `PASS_STATE_TEXT.ok` → **"Password recorded — this rig's password is
  on record and will work as proof."**; every reject state (too short / too long / too common /
  charset / invalid) keeps its text, they are real diagnostics. The live-session lines: the old
  **Mismatch** fired at *two* distinct passwords and told everyone to run one password everywhere
  — it is now **"Too many passwords"** and fires only past `proofs.max`; two or more within the cap
  is an OK **"On record"** line. *None usable* and *Partial* keep their logic.
- **`max === 0` means "the backend did not send a cap", never "zero allowed."** Both branches that
  depend on it fail quiet: no over-cap warning, and the multi-password line drops its *"both are on
  record"* verdict for a claim-free reading — the build that sends no cap is the 2-slot one, where
  that promise would be false.
- **Static copy.** The *Accepted:* line under the input ("any IP your rigs have recently submitted
  shares from … the pool keeps up to 10 of each"), and the fold: a new *What the pool keeps*
  paragraph (10 of each; a reconnect from a known IP refreshes it and does not restart the
  destination-change clock; past 10, the least recently used drops off), a new *If a proof appeared
  that you did not add* paragraph (the deleted banner's content), and *Setting one* with the
  same-password rule demoted to a convenience. The *can't be used to steal your coins* and
  *factory defaults* paragraphs are unchanged — both still true. *(2026-09-23: the whole fold is
  gone — §10.5 Part 3 has where each of these facts lives now.)*
- **DEMO dataset** now carries `proofs: { ip: 3, pass: 2, max: 10, anchor: true, last_added_at }`
  and `live.distinct: 2`, so the operator's no-API preview renders the shipped shape and shows the
  multi-password case as normal rather than as the warning it used to be. `evidence` is gone.

**Deviation from the run plan**, deliberate: the plan said keep *Partial* as it was, but its
sentence was *"Set the same password on every rig"* — a 2-slot workaround, and §17.5 names
`renderPasswordProof` as copy that must change. It now reads *"Set one on that rig too — it does
not have to match the others."* Logic unchanged. Part 3's grep (`last two|last-2|two most recent|
prev_*`) would not have caught the sentence.

**Numbers in prose.** The fold and the *Accepted:* line spell the cap as a literal **10**;
`PROOF_SET_MAX` is a hardcoded constant by design (§17.2 #1), not a setting, so there is nothing
to interpolate — but if it ever moves, these two strings move with it. The rendered lines
(hint, over-cap warning) all read `proofs.max` from the API.

**Not touched:** every backend file, `public_html/index.html`, the CMS defaults — Part 3 owned
those (done 2026-09-23, below).

Verified locally, one-shot only: `npm run check-syntax` (65 files + 32 inline `<script>` blocks,
which covers this page), `npm test` **875/875 across 15 suites, unchanged** — no suite asserts
this page's copy — and a scratchpad `vm` probe that pulls `proofHintText`/`renderPasswordProof`
straight out of the HTML and runs 22 assertions over all their branches (it caught two real
defects before passing: a fabricated timestamp in a fixture, and the *"on record"* promise on the
no-cap path). No server, no browser. Mobile: no block gained a fixed height — `.pass-diag` is a
wrapping flex column, the fold is `<details>` and ships collapsed — and the longest new uppercase
`<b>` label, **TOO MANY PASSWORDS** (18 ch), is shorter than the shipping
**PASSWORD UNSUPPORTED CHARACTERS** (31 ch), so no new overflow surface. The 390 px iframe probe
needs a browser and was **not** run.

#### Part 3 — copy sweep (2026-09-23, copy and comments only)

No logic changed. Started from the run plan's grep (`last two|last-2|last 2|two most recent|
prev_ip|prev_pass`) plus a wider one for the Part-2 lesson — the phrasing that states the 2-slot
rule without naming it (`same password on every|same PIN on every|same</em> one|proof window`).

| Surface | Change |
|---|---|
| `public_html/index.html` setup guide, step *Password* | "**Use the same PIN on every rig**" → each rig may have its own PIN, the pool keeps up to 10, one PIN everywhere is only easier to remember |
| `lib/pool-settings.js` Terms | ownership check = "a source IP your address has recently mined from, or the stratum password on one of your rigs … up to ten of each" |
| `lib/pool-settings.js` Privacy | "last two IPs / last two passwords" → up to ten of each, least recently used dropped past ten |
| `lib/pool-settings.js` FAQ ×3 | the *Password* bullet, "only your last two are kept", and the rotation answer ("the last two are both accepted") restated for a set of ten; different passwords per rig all work |
| `lib/pool-settings.js` | Terms / Privacy / FAQ *Last updated*: July → **September 2026** (those pages' content changed) |
| `index.js` | the `requireBothProofs` comment ("live last-2 window" → a live set row, age = write-once `first_seen_at`); the `nostr-destination` `API_DOC_META` row and the 409 `anchor_not_accepted_here` error text — both said "your original recorded proof", which since Part 1 means only an EVICTED anchor |
| `lib/stratum-server.js` | three "proof window(s)" comments → "proof set" |
| `lib/owner-proof.js`, `lib/db.js` | one stale "proof windows above"; the legacy anchor-column comment put in the past tense and corrected to say only an EVICTED anchor is refused by `requireBothProofs` |
| audit §J3 resolution pass + Status roll-up | pointer notes to design §17; which §J3 conclusions still hold, which are superseded. No finding rewritten |
| this file §2b runbook + §10 head, design §6 slatepack note | pointer / present-tense fixes |

`admin-panel/users.html` (named in design §17.5) states no proof window — its "window" is the
audit-log time range — so it is unchanged. `API_DOC_META` for `GET /api/account/:addr` was already
correct from Part 1.

**⚠ Installed pools keep the old CMS text.** The Terms/Privacy/FAQ bodies are *seed* values: `lib/db.js
migratePagesFromConfig` copies them into the `pages` table once (marker `_migrations.pages_seeded`)
and never again, and `POST /api/admin/settings/:section/restore` resets `pool_config` sections,
not `pages` rows — there is no restore-to-default for a page. A pool that has ever started keeps the
2-slot wording until the operator pastes the new text into those three pages in **Admin → Pages**.
Left as a finding for Part 4 (a copy sweep must not change behaviour); a fresh install gets the new text.

Remaining grep hits are deliberate history: the legacy-column schema and the migration that reads
it (`lib/db.js`, `lib/owner-proof.js`), comments that describe the old window in the past tense
(`index.js` migration call, `lib/miners.js getPasswordConsistency`, `owner-proof.js` header), the
regression tests that build legacy rows, and the dated audit findings.

Verified locally, one-shot only: `node --check` on the five edited `.js` files; `npm test` —
`check-syntax` (65 files + 32 inline blocks) and **875/875 across 15 suites, unchanged**. No server.

#### Part 4 — independent review (2026-09-23)

Read cold against design §17 + §17.4: the full `lib/owner-proof.js`, every reader/writer of
`miner_proofs` (grep: `owner-proof.js`, the two `index.js` views, `lib/db.js` schema — nothing
else), `requireBothProofs` and every `verifyOwnerProof` call site, the startup order, both work
guards in `lib/stratum-server.js`, `test-owner-gate.js` in full, the page's two renderers, and the
Part 3 diff. The ten questions and their answers, with the evidence, are design §17.7. What
changed in the code:

| # | Defect (confirmed before the edit) | Fix |
|---|---|---|
| 1 | **Migration ran AFTER the stratum listener.** `migrateProofSet(db)` sat ~130 lines below `stratumServer.start()`, behind `await nostrBridge.start()` — so with Nostr payouts on, shares were accepted (and could anchor an empty set to a stranger) while the relays answered. The §J3 `backfillProofAnchors` had the identical placement; the comment claiming "ahead of the stratum listener" was false for both. | `index.js`: call moved to immediately before `stratumServer.start()`. Source-order check added (fails on the old file: statement order wrong AND an `await` between). |
| 2 | **Racing duplicate capture evicted a second proof.** `_captureProof` re-located its pre-KDF match by the old hash string only; if a capture of the same value inserted it (or rewrote the matched v1 row as v2) during the v1 awaits, the re-read missed it, the insert path evicted an owner row, and the INSERT was then IGNOREd. Reproduced: a full set lost **2** rows for one new value and was left at **9**. Needs v1 rows for the await window — i.e. migrated accounts. | `lib/owner-proof.js`: the re-read also matches on the capture's own v2 digest. Now 1 row, set stays at 10. |
| 3 | **A returning evicted anchor kept its original `first_seen_at`.** Once live it verifies as `'set'`, so four shares from whoever holds that value now (the owner's old CGNAT or re-leased IP) turned the evicted-anchor refusal (§J3-4) into an aged destination leg. The window never had this: a returning value got a fresh age. The password leg still blocks theft; this is defence in depth, restored. | `lib/owner-proof.js`: re-activation sets `first_seen_at = now`. The one write that moves it, and only forward. Test asserts the age restarts and the leg is refused. |
| 4 | **`proof_too_recent` text quoted the wrong number.** It printed `cooldownH`, not the enforced `minAgeSec` — with the cooldown at 0 it told the miner "at least 0 h old" while refusing (pre-§17, from the §J3 self-review). | `index.js`: prints `Math.ceil(minAgeSec / 3600)`; the `anchor_not_accepted_here` text interpolates `PROOF_SET_MAX` instead of a literal 10. |
| 5 | **KDF cost under-stated** everywhere it was written (§17.4, this section, the `verifyOwnerProof` comment, whose memo note claimed the opposite of what the memo does). | Comments/docs corrected; the 2-digest case and the 8-call ceiling are now asserted. No behaviour change. |

Plus test coverage for a path that was claimed but not exercised: the migration check whose comment
said *"an anchor that EQUALS the current window value is ONE row, and it is live"* used data where
the anchor differed from both slots. The EQUAL case is the common one (the old backfill seeded the
anchor FROM `last`) and is now its own check — it already worked.

**Decided, not changed:**
- **CMS re-seed (Part 3's carry-over): stays an operator note.** The pages are operator-owned
  legal text, and a versioned re-seed would overwrite edits. The stale text is *understated*
  (says two are kept), not unsafe. A conditional re-seed of pages still byte-identical to the old
  default is possible later if it is ever wanted; it is not a safety fix.
- **The 409 `anchor_not_accepted_here` text (Part 3's rewording) is accurate** — it fires only
  for an evicted anchor, and it says so.
- **Open, for Part 5:** `pass_proof_state = 'ok'` reads *"Password recorded — … on record"* and the
  multi-password line says *"all of them are on record"*, but a NEW password on an address that
  already has one is inserted only at `PROOF_MIN_SHARES` (share 4), not share 1. Between the two
  the page over-claims. That gap is transient if share 4 comes in minutes, which is the §J3 open
  question Part 5 measures. Reword the text only if the measurement says it can take hours.

Tests: `test-owner-gate.js` **36 → 42**, suite **875 → 881** (`npm run test:unit`, exit 0, 15
suites). Each new regression check was run against the pre-review code first and failed there
(anchor age, source order; the race by the same scratch script before/after). No server started.

**Owed:** Part 5 (VPS acceptance). Nothing here has run outside a local harness.

### 10.5 Payout rails fix — Slatepack params, Tor probe, slimmer P-04 (2026-09-23, add-ons — NOT VPS-tested)

> *Two later uses of the probe (2026-09-26, §10.10).* The pre-flight 409's `tor_online: false` +
> `suggest: 'slatepack'` now drive the account page's *Send as Slatepack instead* offer. Keep both
> fields exactly, and note that a 409 refusal is not counted toward the Tor pause. The same
> `probeToronlineStatus` also runs **once, fresh, after a send falls back to a slatepack**, and its
> tri-state names the failure's `fail_code`.

**Origin:** an operator test on 2026-09-22 found that **both** miner payout rails on the account
page (P-04) failed. Slatepack returned `failed to create slatepack: Wallet RPC error:
InvalidArgStructure "slate" at position 1`. Tor showed *"✗ not reachable"* for a wallet that Tiny
Explorer's wallet check (06d) reported as up. The work ran in three code parts plus this docs fold.
Suite **881 → 945** across 16 suites (`npm test`, exit 0). **None of it has run on a VPS.**

#### Part 1 — Slatepack: named params for `create_slatepack_message` (`lib/wallet.js`)

- **Root cause, confirmed:** `createSlatepackMessage` sent positional params
  `[token, sender_index, recipients, slate]`, but Owner API v3 declares
  `create_slatepack_message(token, slate, sender_index: Option<u32>, recipients: Vec<SlatepackAddress>)`.
  The wallet read the number `0` as the slate. The error names the argument the wallet
  **expected** at that position (`slate` at index 1), not the one it received. The Goblin/Nostr
  rail calls the same wrapper with `recipients: []`, so it was broken too. On the failure path
  `cancelTx` and `_reverseLock` still ran, so the failed tests stranded no coins. Each one did
  arm the post-return cooldown.
- **Fix:** the call now sends **named** params
  `{ token: null, slate, sender_index: senderIndex, recipients }`, which cannot be misordered.
  051 Fidelius and the 053 bridge already made this call with named params, and both work. The
  keys must match the Rust parameter names exactly. A misspelt key is **rejected, not ignored**:
  easy-jsonrpc (master, read 2026-09-23 in the Part 5 review) turns the missing real name into
  `MissingNamedParameter` and the stray key into `ExtraNamedParameter`. Not re-checked against
  the exact `easy-jsonrpc-mw` version grin-wallet v5.4.1 pins.
- **`_call` accepts both param shapes.** It fills an array's `params[0]` or an object's
  `params.token` through the new `_fillToken`, at **both** sites: the first call and the
  session-retry branch. The retry branch must refill the token too, because re-initialising the
  session rotates it. Missing it there is a bug that shows up only after a wallet restart.
- **`sender_index` stays `0`, never `null`.** With `0`, the miner's response slatepack is
  encrypted back to the pool's index-0 address, and `finalizeSlatepackWithdrawal` decodes it
  with `secret_indices [0]`. The 053 bridge uses `null` to stop a Tor auto-reply from bypassing
  its DB. That trap cannot apply here, because the pool's `owner_api` listener publishes no onion
  (memory `project_pool_wallet_combined_listener`).
- **Audit of the other 10 Owner calls** in `lib/wallet.js`, checked against v5.4.1
  `owner_rpc.rs`: `retrieve_summary_info`, `retrieve_txs`, `retrieve_payment_proof`,
  `get_slatepack_address`, `init_send_tx`, `tx_lock_outputs`, `slate_from_slatepack_message`,
  `finalize_tx`, `post_tx` and `cancel_tx` are all in the right order. `create_slatepack_message`
  was the only wrong one, and the only one converted.
- **Tests:** new `scripts/test-payout-rails.js`, wired into `test:unit`. It checks the wire
  shape (an object, not an array), the token, the slate passing through with its `id`,
  `sender_index 0`, recipients as given, the empty-recipients Goblin call, the token refill on a
  session retry, and that the array path is not regressed. With the old `wallet.js` restored,
  the shape checks fail.

#### Part 2 — Tor probe ported from 06d (`lib/wallet-tor.js`, `lib/socks5.js` NEW, `lib/config.js`, `index.js`)

- **Why the old probe said "offline" for a live wallet.** Four faults compounded:
  1. The timeout was **3000 ms**, but a cold onion connect routinely takes 5–15 s.
  2. The `socks` npm lib reports a timeout as `'Proxy connection timed out'`, and that string
     matched neither of `_torConnectOnce`'s patterns. So hearing nothing back fell through to
     `{ online: false }`, a **confident** offline built from no information.
  3. Retries reused one circuit, so retry 2 repeated retry 1's failure.
  4. A bare SOCKS CONNECT proves that a stream opened, not that a grin-wallet is there.

  The withdraw **pre-flight gate** runs the same probe, and a false `false` there is an HTTP 409
  that refuses the payout. So this bug also blocked payouts, not just the status line.
- **Fix: port 06d's probe**, which had worked live against the operator's wallet. It is copied
  in, not required across products, because the two products deploy separately.
  `lib/socks5.js` is 06d's zero-dependency SOCKS5 client. Its one deliberate change is the
  isolation-credential literal (`grinpool`). Its header gives a `diff` command that must print
  only that one line pair. `lib/wallet-tor.js` keeps the public contract,
  `probeToronlineStatus(address)` → `{ online: true | false | null, reason }`, and its bech32/onion
  derivation. That derivation was verified byte-identical to 06d's. The file header lists every
  divergence from 06d.
- **What the probe proves now.** It opens a SOCKS5 tunnel to `<onion>:80` (the wallet's HS
  virtual port) and **POSTs `check_version` to `/v2/foreign`**. A parsed JSON-RPC answer, or an
  HTTP 401, is the proof.
- **Tri-state, by reason code** (`REASONS` in `wallet-tor.js`; the route returns the codes
  verbatim):

  | `online` | reasons | meaning |
  |---|---|---|
  | `true` | `reachable`, `reachable_auth` | a grin-wallet answered (401 = one that asks for auth) |
  | `false` | `onion_unreachable`, `onion_timeout`, `no_answer`, `not_wallet`, `invalid_format` | our tor works and that wallet did not answer; or a non-wallet answered; or the address can never be paid |
  | `null` | `tor_unavailable`, `derivation_failed`, `probe_failed` | **we could not look** — says nothing about the wallet |

  `classifyProbeError` makes the false/null split using three signals, strongest first: a SOCKS
  reply byte, `proxyResponded` from `socks5.js`, then the error string. **A timeout with zero
  bytes back from the proxy is `null`, never `false`.** That is the line the old probe was
  missing. `invalid_format` → `false` is a deliberate divergence from 06d, which returns `null`:
  the pool is gating a payout, and "nothing can ever be sent there" is a decision.
- **Timing and retries.** `tor_check_timeout_ms` is now **8000** (was 3000) and
  `tor_check_retries` stays **2**, in both `wallet-tor.js` and `lib/config.js`. Every attempt
  carries its own SOCKS **isolation tag** (`grinpool-<n>`), so tor builds a fresh circuit for it.
  The probe stops early on `true`, on any `null` (our side is broken, so a retry only costs time)
  and on `not_wallet` (a stable fact about the far end). The connect function is injectable
  (`deps`), so the tests need no tor. `_torConnectOnce` and `require('socks')` are gone. No
  installer pins `tor_check_timeout_ms` into a pool config: the only pin under `scripts/` is
  06d's own 8000.
- **`GET /api/account/:addr/tor-check?fresh=1`.** A fresh request skips the 60 s cache, but only
  once the cached answer is **10 s** old (`TOR_PROBE_FRESH_FLOOR_MS`). A younger answer is served
  as-is, so a click-spammer cannot turn the cache off. The `torcheck` bucket (10/min), the
  in-flight dedup and the 404 for an address that never mined here all still apply. The result
  of a fresh probe is stored in the cache. The `API_DOC_META` row now lists the reason codes and
  the floor. **The pre-flight gate is unchanged.** It always probes fresh, never reads the cache,
  and still runs after `precheckWithdrawable`, an ordering that `test-rate-limits.js` asserts.
  It fails OPEN on `null` (with the `[tor-preflight] gate could not run` warning) and blocks on
  `false`.
- **Tests:** a Tor-probe section in `test-payout-rails.js` covers the classification with an
  injected connect, the defaults, the `?fresh=1` source checks, and real sockets against a fake
  SOCKS5 proxy bound in-process to 127.0.0.1. The regression check: with the old
  `wallet-tor.js` restored, a silent proxy gives `{ online: false, reason: 'unreachable' }`, and
  the test fails.

#### Part 3 — P-04 slimmed (`public_html/account-settings.html` only)

- **Tor pane: two buttons and one status line.** *Check Tor wallet* (`#acct-tor-check`, a quiet
  `.btn-quiet` variant of `.btn-save`) sits beside *Pay to Tor wallet* (`#acct-withdraw`). The
  explanatory paragraph and the `acct-tor-recheck` chip are gone: the Check button **is** the
  re-check, and it calls `?fresh=1`. `#acct-tor` stays **empty** until the miner clicks Check.
  While probing it reads *"Checking… (can take up to 30 s)"*, then one of three outcomes: *"✓ Your
  wallet answered"*, *"✗ No answer — start your wallet listener, or use Slatepack"* or
  *"Couldn't check from here — you can still request the payout"*. The raw reason goes into
  `title`. `torSeq` discards an answer that arrives after a newer check or a new lookup.
- **No probe on page load.** `lookup()` no longer calls `torCheck(addr)`; it calls
  `resetTorStatus()`. Before, every page view built a Tor circuit to the miner's onion. The pay
  path still probes fresh through the gate. Pay shows *"Checking your wallet over Tor, then
  sending… (up to 30 s)"*. On a gate 409 it writes the ✗ line and *"Not sent — nothing was
  deducted."*, which is accurate because the gate runs before the balance lock.
- **The *Why does my rig password matter?* fold is removed**, together with its `.gate-why`
  CSS, at the operator's request: it repeated the homepage setup guide. A single link replaces it:
  *Password rules → Miner setup* (`/#rx-miner-guide`). Where each of its facts lives now:

  | Fact | New home |
  |---|---|
  | it can't be used to steal coins; what the gate stops; a stranger's proof is harmless | **HTML comment above the gate label** + the withdraw route's comment in `index.js`. No miner-visible home. |
  | 10 IPs + 10 passwords kept | the *Accepted:* hint under the input + homepage setup guide |
  | a password survives an IP change; each rig may use its own | homepage setup guide |
  | defaults / repeats / straight runs / < 8 / non-Latin refused | homepage setup guide, the *(8–128)* label, the password diagnostics on a failed submit |
  | a returning IP only refreshes; LRU of 10 drops off, so a rotation never locks anyone out | design §17 only (no page) |
  | how to set one | homepage setup guide |

  ⚠ **This reverses a placement made by the proof-set work** (design §17.2 #8, and §10.4 Part 2
  above). That work moved the "can't steal" paragraph and the *someone else mined to this
  address* explanation **into** the fold. The operator chose less text over keeping them
  visible.
- **Other cuts.** The panel-title tagline is gone. The Slatepack steps are one line. The two
  textarea labels are shorter. The closing note is down to two sentences: one payout at a time,
  and an undelivered payout returns automatically. `#acct-fee-note` and its JS are gone, and the
  fee explanation is now the `title` on the *Withdrawal fee* label. **Still visible:** the fee →
  you-receive preview, the sub-threshold note, the *Accepted:* hint, the password diagnostics and
  the pending strip. Everything cut is kept as an HTML comment where it stood. P-04 went from
  **1014 → 342** visible words (847 → 175 without the Goblin-only destinations section).
- **Verified:** the suite is unchanged at 945, and `test-public-leakage` reads this page. A
  headless-Chrome probe against the demo account, at 1280 and 390 px in the atomic, light and aqua
  themes, showed 0 console errors, **0 tor-check requests on load** and no horizontal overflow.
  The real probe and the 409 branch were verified by reading only; the demo cannot reach them.

#### Part 5 — independent review (three fixes, each with a test that failed first)

Suite **945 → 960** (16 suites). All three new test groups in `test-payout-rails.js` failed
against the Parts 1–4 code and pass now.

- **A drip-fed reply held a probe open for about a day** (`lib/wallet-tor.js`). The reply phase
  had only `req.setTimeout`, which is an *inactivity* timer, and the far end of that socket is the
  address holder's own onion. One byte every few seconds kept resetting it until Node's 16 KB
  header cap. 06d has the same idle-only timer but caps concurrent probes at 4. The pool has no
  cap, so every withdraw POST could hold one request and one socket. **Fix:** an absolute
  `deadline` timer, so the whole reply must arrive within `tor_check_timeout_ms`. **Test:** a fake
  proxy that feeds one byte per 100 ms. The probe used to be still pending at 4 s; it now returns
  `no_answer` inside the budget.
- **Something other than SOCKS5 on `tor_socks_port` blocked every Tor payout**
  (`classifyProbeError`). A wrong protocol version, or refused auth, has `proxyResponded` set, so
  it scored a confident `false`. The port could point at tor's ControlPort or an HTTP proxy. **Fix:**
  `lib/socks5.js`'s own proxy-level messages classify as `tor_unavailable` → `null`, so the gate
  fails open. 06d still scores them `false`; this divergence is listed in the file header.
- **A 504 left a payout that the miner was told had failed** (`index.js` pre-flight gate). This was
  Part 4's open question, and the answer is yes. After nginx's 30 s it answers the browser 504
  (*"Withdrawal failed"*) and closes the upstream socket. Express kept running the handler, the gate
  passed, and `createWithdrawal` locked the balance and queued the payout. **Fix:** after the probe,
  `if (res.destroyed)` writes a `requester_gone` audit row and returns without creating anything.
  It has to be `res.destroyed`: Node ≥ 16 sets `req.destroyed` on every request once the body is
  read. The suite proves both on the running Node, and a source check pins the guard between the
  probe and `createWithdrawal`.

#### Open follow-ups (not fixed here)

- **Worst-case probe time still exceeds the `/api/` read timeout.** The worst case is
  `tor_check_retries × (connect + reply)` = 2 × 2 × 8 s ≈ **32 s**. The pool vhost's
  `location /api/` sets `proxy_read_timeout 30s` (`07_grin_mining_public_pool.sh`). Since Part 5
  this can no longer create a payout the miner never saw, but a probe that runs slow still shows
  *"Withdrawal failed"*, and the miner has to press Pay again. The real fix is to raise that
  location's timeout, or give withdraw its own location. The alternative is to cap the probe's
  total time below 30 s.
- **No global in-flight cap on probes.** 06d caps them at `tor_check_max_inflight` (4). Since
  Part 5 each probe is bounded (≈32 s), so concurrency is limited by the per-IP `withdraw` and
  `torcheck` buckets, but not across IPs.
- **`?fresh=1` sharpens the uptime signal** from 60 s to 10 s per address, within the `torcheck`
  bucket. That is a design trade against the uptime signal §J3-9 accepted; nobody has signed it off.
- **`socks` is still in `package.json`, but nothing requires it.** Dropping it is a lockfile
  change (memory `reference_npm_lockfile_deploy_gate`), so it was left for a deliberate commit.
- **Two stale comments:** "≤6 s" for the probe in `withdrawal-scheduler.js`, and the
  `rate-limiter.js` `torcheck` bucket comment, which predates `fresh`.
- **P-08's `#wd-proof-note` is 137 words.** Part 3 proposed a cut in its report but did not
  make it.

**Owed:** VPS acceptance (Part 6): testnet first (listener
up, listener down, pool tor stopped → fail-open, a Tor payout with its proof, a Slatepack
round trip, a Slatepack abandoned to its TTL), then mainnet.

### 10.6 Donations v2 — per-share donation + reviewed donor profiles (design §18; 2026-09-24, add-ons — NOT VPS-tested)

Design contract: [`script07_design.md` §18](script07_design.md). Built in seven parts. This
section gets one sub-heading per part as it lands. **Nothing here has run on a VPS.**

#### §18 Part 1 — per-share donation (2026-09-24, uncommitted)

**What changed in the money.** A `donateN` tag now donates N % of the PPLNS credit **that
share** earns, read from `shares.worker_name` at distribution. Nothing is stored per address.
- `lib/rewards.js`: each `distribution` entry gets
  `donate_pct = parseDonateToken(share.worker_name)?.percent ?? 0`. `creditBalances` builds
  `donateMap` (address → Σ credit × pct/100) next to `minerMap`, in the same order, and passes it
  as the 4th argument of `applyToDistribution`.
- `lib/incentives.js applyToDistribution(blockHeight, minerMap, poolFee, donateMap)`: the
  donation leg iterates `minerMap`, so only an address this block credited can be debited. It
  reads `donateMap.get(address)`, clamps to `min(donated, gross)`, and skips reserved addresses.
  It runs only when `incentives_enabled` **and** `allow_miner_donations` are on. The ledger shape
  is unchanged: one `debit/donation` per address per block and one `prize_pool` `credit/donation`.
  `donor-ledger.js`, the prize-pool statement and `reconciliation.js` needed no change. The
  invariant test below checks that pot credits equal the sum of donor debits.
- **Removed:** `IncentivesManager.donationPercent` + `setDonation`; in `lib/stratum-server.js`
  the parked donation (login block, the `PROOF_MIN_SHARES` donation branch,
  `_applyParkedDonation`, `_captureDonorName`), plus its now-unused `IncentivesManager` and
  `donor-names` requires and the `this.incentives` field; `miners.js` session `donationPercent`;
  `validateUsername`'s `donor_label`. `validateUsername` still returns `donation_percent`, but
  nothing stores it. `PROOF_MIN_SHARES` stays because ownership-proof capture still uses it.
- The `miner_incentives.donation_percent` column and the six v1 `donor_*` columns stay in the
  schema. **Nothing reads the percent column.** `lib/donor-names.js captureDonorName` stays in the
  lib with **no production caller** until Part 3 removes v1 moderation. Names v1 already stored
  still display through `displayState`.

**Live readings (§18.3).** `lib/donor-ledger.js liveDonations(sessions)` is pure. It reads
MINING sessions only (`acceptedShares > 0`) and counts distinct worker names. It returns
`Map<address, { rigs_online, rigs_donating, pct_min, pct_max, donating_workers: [{name, percent}] }>`.
`donate0` counts as online, not as donating. The export `NO_LIVE` is the empty reading. The
callers apply the `donationsActive()` gate. Every added field is additive, and the kept fields
still feed today's pages until Parts 3–5:
| Surface | Adds | Kept (for the current page) |
|---|---|---|
| `GET /api/account/:addr` | `donation: { rigs_donating, rigs_online, pct_min, pct_max, workers }` | `donation_percent` = `pct_max` |
| `GET /api/account/:addr/workers` | per worker `donate_percent` (null = untagged, or donations off) | — |
| `GET /api/pool/donors` | per card `rigs_donating`, `pct_min`, `pct_max`; `totals.active_donors` = addresses with `rigs_donating > 0` (no more `miner_incentives` COUNT); `donorWall` takes `live` in place of `rigsOnline` | `current_percent` = `pct_max`, `rigs_online` |
| `GET /api/admin/donors` | per row `rigs_online`, `rigs_donating`, `pct_min`, `pct_max`; a row now exists for a debit, a **live** tag (only while donations are on) or a stored name — the `WHERE donation_percent > 0` is gone | `current_percent` = `pct_max` |

API reference rows updated for the three public routes.

**Upgrade effect — put this in the release note.** A v1 address-wide % **stops at deploy**. A
miner who tagged one of five rigs now donates from that one only. A miner who removed a tag but
never sent `donate0` stops donating. Shares already in the PPLNS window keep their tag, so for
about an hour after a rename, a block found then can still take the old tag's cut. The testnet
pool ran the v1 tag with a live miner (§16 intro). Tell the operator before deploying there.

**Interim copy gap (until Part 5).** `account-settings.html` still renders
`donation_percent` as *"N% of new earnings"*. That is now the highest tag among the live rigs,
not an address-wide cut. The row's tooltip still describes the v1 `donate0` ceremony and the
`yourbrand-donate10` name. `donate.html`'s D-01 copy also still describes v1 (Part 4). Neither
page reads a wrong NUMBER. The words are wrong until those parts land.

**Tests.** `npm test` **1134 → 1145**, 19 suites, exit 0.
- `test-money-path.js` 32 → 47, new §3. Cases: one tagged rig of two (only that share's credit ×
  10 %); `donate100` (donated == gross exactly, balance unchanged net); mixed 5 % + 20 %; a
  stranger's `donate100` share on a victim's address (moves only that share's credit); the dead
  column set to 100 with no tagged share (moves nothing); donations off; incentives off; and an
  out-of-range or malformed tag. Two invariants hold for every address in each block: donated ≤
  gross, and prize-pool donation credits = Σ donor debits.
- `test-donor-league.js` 68 → 77: `liveDonations` unit tests (distinct names, the pct range over
  donating rigs only, `donate0`/`donate101`, no-share sessions excluded, junk input) and the wall
  built from `live` (mixed tags, paused, `active_donors` counting an address with no card yet,
  the dead column ignored, switch off, junk readings bounded). The old `current_percent`-from-column
  and `rigsOnline` checks were rewritten.
- `test-donor-names.js` 156 → 145: the 11 checks that drove `_applyParkedDonation` /
  `_captureDonorName` were deleted with the code. The lib's capture tests still run until Part 3.
- `test-stratum-guards.js` 71 → 68: the three `donor_label` checks and the four-field check
  became one check for three fields. The tag grammar checks are unchanged.
- `test-owner-gate.js` stays at 42. The §J3-5 check used to assert that `setDonation` runs on the
  share path. It now asserts that `stratum-server.js` stores no donation at all and that
  `incentives.js` never reads `donation_percent`.
- `test-public-leakage.js` 87 → 88: §9's rig-count check now asserts the route goes through
  `liveDonations` and that the share bar lives there. A new check asserts the wall never reads
  `donation_percent`.

#### §18 Part 2 — donor-profile backend (2026-09-24, uncommitted)

API only. Nothing public reads a profile yet: the wall still shows v1 names until Part 4, and
no admin route can approve anything until Part 3.

**Schema** (`lib/db.js`, in the `CREATE … IF NOT EXISTS` list, so new and existing DBs both get
it and no migrate helper is needed). `donor_requests`, `donor_blocks`, and the three indexes
match §18.4 exactly. The two partial unique indexes (`uq_donor_req_pending`,
`uq_donor_req_approved`) are the "one pending + one approved per (address, kind)" rule. The v1
`donor_*` columns are untouched.

**`lib/donor-profiles.js`** (new; no dependency on `index.js` or `donor-ledger.js`):
- **Name**: `normaliseName` / `validateName`. ASCII whitespace is collapsed. Anything outside
  `A-Z a-z 0-9 space - _ . & '` is refused, including NBSP, zero-width characters, bidi overrides
  and Cyrillic look-alikes. The name is 2–32 characters with at least one letter or digit, and case
  is kept. A non-string is refused as `name_invalid`, not coerced. Codes: `name_invalid`,
  `name_length`, `name_charset`, `name_no_alnum`. Each message states the rule.
- **Banner**:
  - `sniffBanner` uses `asset-manager.js`'s binary `SNIFFERS` only. That array is now exported;
    `detectImage` is never called.
  - `parseDimensions` reads the PNG IHDR (it must be the first chunk, length 13), the GIF
    logical screen, or the JPEG's first SOFn. The JPEG walk skips APPn/DQT/DHT and fill bytes, and
    refuses at SOS or EOI. Every read is bounds-checked, and the parser returns null on any input,
    so nothing throws.
  - `validateBanner` enforces 320–1600 × 80–400 px, 2:1 to 8:1, and ≤ 300 KB. It returns
    `ext`/`mime` from the sniff plus dims, bytes and sha256. Codes: `banner_missing`,
    `banner_too_large`, `banner_type`, `banner_unreadable`, `banner_dimensions`, `banner_aspect`.
- **Donor transitions**:
  - `submitName` / `submitBanner` require `opts.isDonor === true` (fail closed). The caller reads
    the ledger. They re-check the account and the block inside the transaction.
  - An existing pending request becomes `replaced` and loses its blob.
  - A unique-index hit comes back as `{ code: 'conflict' }`. The test proves this with a real
    constraint, not a stub.
  - `withdraw` covers a pending request; `removeLive` covers the live one.
- **Admin transitions** (written and tested now, wired by Part 3): `approve`, `reject`, `block`,
  `unblock`, and `removeLive` with `adminId`. Each writes its `admin_audit_log` row
  (`target_type 'donor'`) inside the transaction: `donor_request_approve`, `donor_request_reject`,
  `donor_profile_remove`, `donor_block`, `donor_unblock`. Every `:id` goes through `parseId`. A
  reason goes through `cleanReason`: one line, no control characters, ≤ 200 characters. A blank
  reason is stored as NULL.
  - `approve` on a banner re-validates the **stored** bytes and takes the extension from that
    sniff.
  - It writes `uploads/donors/<16 hex>.<ext>` (mode 0644, `wx`, containment-checked) **before**
    the transaction and unlinks it if the transaction fails.
  - It unlinks the superseded file after the commit. A failed unlink comes back as `warning`; it
    does not abort.
  - It refuses a blocked address's request.
- **`profileFor`** builds the account's `donor_profile`, and **`publicProfiles`** builds the
  wall's `Map` (approved + unexpired only; Part 4 applies the slot rule). Neither selects
  `image`, and neither reads `name` from a non-approved row. An item expires `months` after
  the **later** of the last debit and its approval. Name and banner expire separately.

**`lib/donor-ledger.js`** gains `leagueRank(db, address, opts)`: the wall's own ordering, 1-based,
or null for the past strip and for anything below `LEAGUE_LIMIT`. A test proves it agrees with
`donorWall`'s numbering.

**Settings.** `donor_banner_slots` has a default of 5, is validated as an int 0–10, and is
re-bounded on read as `donorSettings().bannerSlots`, where junk reads as 5 and `'0'` as 0.
`donor_censored_display` stays until Part 3.

**`index.js`:**
- **`requireBothProofs(addr, body, reqIp, action, purpose = 'destination')`.** `PROOF_PURPOSES`
  changes only the wording. The Goblin texts are byte-identical: the old and new bodies were run
  against stubbed proofs over all 8 refusal and success paths, and all 8 compared equal.
- **Routes** (`rateLimiter 'withdraw'`, both proofs aged, `auditOwnerProof` as
  `donor_profile_submit` / `_withdraw` / `_remove`). The two submits refuse in this order:
  donations off (503), then no account (404), then blocked (403), then `not_a_donor` (409), then
  bad input (400/413), then the proof codes. The input is checked before the proofs, so a typo
  never burns a proof attempt. The banner route runs the four checks that need no body
  **before** multer reads it.
  - `POST /api/account/:addr/donor-profile/name` returns the typed name, and only this route
    does.
  - `POST …/donor-profile/banner` is multipart, with `file` plus the two proof fields.
  - `DELETE …/donor-profile/:kind` takes `{ which: pending|live }` and needs both proofs. It does
    **not** need donations on, a debit, or an unblocked address, because removing your own data
    is always allowed. It returns 404 before spending a proof attempt when there is nothing to
    act on.
- **`GET /api/account/:addr`** gains `donor_profile`, guarded to `null` on failure.
  `slot_rank` costs one ledger scan and only runs for an address that has donated.
- **API reference**: three new rows, and the account row documents `donor_profile`.

**Upload size, measured, not assumed.** A one-shot run fed multer's real stream parser a fake
request, with no server.
- Busboy trips `LIMIT_FILE_SIZE` when a file **reaches** the limit. So the limit is
  `MAX_BANNER_BYTES + 1`: exactly 300 KB passes to `validateBanner`, and 300 KB + 1 is refused.
- Multer stops **buffering** at the cap but reads and discards the rest of the body before the
  413 goes out. Memory per request is bounded at about 300 KB.
- The total body is bounded by nginx: the public `location /api/` sets no
  `client_max_body_size`, so the 1 MB default applies.

**§18.4's deploy claim, verified in `07_grin_mining_public_pool.sh`.** The claim was "no
deploy-script change".
- The nginx `location /uploads/` aliases `$POOL_APP_DIR/uploads/` with nosniff and the sandbox
  CSP.
- Both backend rsyncs pass `--exclude='uploads'`.
- `07_lib_pool_backup.sh` lists `uploads`.
- `uploads/donors/` is created by the app (0755) on the first approval.

**Tests.** `npm test` **1145 → 1298**, 19 → 20 suites, exit 0. The +153 is exactly the new
suite, so no existing suite changed.

`scripts/test-donor-profiles.js` (153) was added to `test:unit` after `test-donor-league`. It
covers:
- the name rules;
- sniff and dims on hand-built PNG/GIF/JPEG, including truncated, lying, zero and 2³²-wide
  headers, SVG, WEBP, and the 300 KB / aspect / size edges;
- a fuzz pass over 3,500+ truncated and random inputs: nothing throws, and nothing out of bounds
  is accepted;
- every transition, including both unique indexes directly and the conflict mapping via a real
  constraint;
- the file writes: one file, the submitted bytes, a second approve deleting the first, and an
  unwritable dir leaving the request pending with its blob;
- `profileFor`: never carries the pending name, bytes or `decided_by`; handles rejection
  supersession and admin-vs-donor removal;
- `publicProfiles`: excludes pending, rejected and expired; a non-conforming stored filename
  never becomes a URL;
- the settings bounds;
- `leagueRank`;
- route wiring read as text: withdraw limiter, the `'donor_profile'` gate on all three routes,
  the banner route refusing before multer, input validated before proofs, and the account route
  reaching `donor_requests` only through `profileFor`.

#### §18 Part 3 — admin review queue + moderation swap (2026-09-24, uncommitted)

Admins can now approve profiles. v1's post-moderation is gone. An approved **name** shows on the
wall from this part on. **Banners** still reach no public page until Part 4.

**Admin routes** (`index.js`, the `DONORS (Admin only)` block). All reads are `secureAdmin`. All
writes are `freshAdmin`, and each one delegates to the Part 2 lib, which writes the state change
and its `admin_audit_log` row in one transaction.

| Route | Does |
|---|---|
| `GET /api/admin/donors/requests?status=&limit=` | The queue. `status` is a closed enum and defaults to `pending`, oldest first. The decided statuses are the history, newest decision first. Each row gets `rank`, `lifetime_donated` and `last_donated_at` from one ledger scan. |
| `GET /api/admin/donors/requests/:id/image` | Returns the pending blob or the approved file. Headers: `Content-Type` = the stored mime (png/jpeg/gif only, anything else is refused), `nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cache-Control: no-store`, `Content-Length`. No bytes → 404; bad id → 400. |
| `POST …/requests/:id/approve` · `…/reject {reason}` | `approve()` / `reject()`. A banner approve with no uploads dir → 503 before the lib, since the lib would throw. |
| `POST /api/admin/donors/:addr/remove {kind, reason}` | `removeLive()` with `adminId`. `kind` is a closed enum. |
| `POST /api/admin/donors/:addr/block {reason}` · `/unblock` | `block()` also withdraws pending requests. The note stays admin-side. |
| `GET /api/admin/donors/summary` | `{ pending_requests }`, which drives the nav badge. |
| `GET /api/admin/donors` | Rewritten list. Per row: live `name` / `banner` (with the donor's own expiry state), `pending: {name, banner}` and `blocked`. Workers carry `donate_percent`. `current_percent`, the `donor_censor*` fields, `is_new`, `renamed_while_censored` and `new_names_7d` are gone. A row exists for a debit, a live tag while donations are on, or **any profile row or block**, so a blocked address can be unblocked. |

`:addr` goes through `GRIN_ADDR_RE`. Lib codes map through one `DONOR_ADMIN_CODES` table.
The dashboard's `new_donor_names_7d` became `pending_donor_requests`, and the Overview tile
changed with it.

**Removed:** the `censor` / `uncensor` routes, the rescan-on-settings-save hook,
`donor_censored_display` (default, validator and form), and in `lib/donor-names.js`:
`captureDonorName`, `rescanAll`, `adminCensor`, `countNewNames`, `NEW_NAME_DAYS`,
`CENSORED_MARKER`, `CENSORED_DISPLAY_VALUES`, `displayState` and `matchBlocklist`.
- A pool that still has a `donor_censored_display` row in `pool_config` is harmless: nothing
  reads it and no form binds it. A save that sends the key now fails with `Unknown key`.
- `lib/donor-names.js` kept `normalise`, `parseList`, `poolNameEntry`, `matchEntries`,
  `RESERVED`, `STARTER_BLOCKLIST`, `addMonthsUtc` and `donorSettings`. It gained
  `nameFlagContext` / `nameFlags` for the queue flags.
- `normalise` now also strips space, `.`, `&` and `'` (the v2 name separators), so
  `Acme & Co.` and `acme co` compare equal.
- The `donor_*` / `donation_percent` columns on `miner_incentives` stay in the schema, and
  nothing reads them any more.

**Flags** (hints, never decisions), computed at queue-read time from one context per read:
- `reserved`: a fixed word, or the pool's name if it is 3+ characters.
- `word`: an entry from the operator's list.
- `same_as_donor`: the addresses of **other** donors whose approved name normalises the same.
  Expired approvals count, because an expired name comes back with the next donation.

300 names against a 4,000-entry list flag in milliseconds, because the list is parsed once.

**`lib/donor-profiles.js` admin reads** (new):
- `adminQueue`: never selects `image`. `has_image` is true only for a pending blob or an
  approved file of the exact server shape. `current` is the address's approved item of the same
  kind, so a rename reads as a rename.
- `requestImage`: containment and `FILE_RE` checks on the approved file. A missing file → `no_image`.
- `adminProfiles`: uses the same `isExpired` rule as `profileFor`.
- `pendingCount`.

**v1 names stop showing everywhere.** `donorWall` now reads names from `publicProfiles`, which
returns approved, unexpired rows only. The wall response dropped `censored_display`.
`/api/account/:addr`'s `donor_name` / `donor_name_state` are **derived from `donor_profile`**
(`none` → `masked`). v1 names were never reviewed, so pre-moderation starts clean, as the plan
notes. Part 4 still owns banners, the slot rule and `current_percent`.

**`admin-panel/donors.html`** (rewritten). The page has three sections, so the section rail
picks up three chips:
1. **Review queue** (an AdminTable). Name requests show in the mono face with their flags and
   the live name they replace. Banners show the image and its dims, KB and mime.
   - Each row has an inline reason box. Its note says the reason is shown on the donor's public
     account page.
   - A typed reason survives repaints: it is written through to a `Map`, and the row reads it
     back.
   - The queue does **not** poll, because a timer repaint would wipe a reason being typed. It
     reloads after each decision and on Refresh.
2. **Donors.** Live name + state, the banner thumbnail (public `/uploads/donors/` URL,
   shape-checked) with "showing / not in top N", pending and blocked badges, the donating %
   range, and "k of n rigs". Actions: ✂️ remove name, 🖼 remove banner, 🚫 block / ✅ unblock.
   Remove and block use an **in-page** reason dialog (`.modal-overlay`, never `prompt()`).
   Unblock uses one `confirm()`.
3. **Donation settings.** The word list is relabelled *"Flag words — highlighted in the review
   queue"*. `donor_banner_slots` was added, and the expiry field was renamed "Profile expiry".

`admin-shell.js`: the badge now shows the pending count, and `AdminTable` gained an optional
`onRender(tbody)` hook. The hook is try/caught and runs only after real rows are painted. The
queue uses it to wire the reason boxes and each banner's error handler.

**Banner previews: a plain same-origin `<img src>`, no CSP change.** Each queued banner's `src`
is `/api/admin/donors/requests/<id>/image`. The access token is an httpOnly `SameSite=strict`
cookie on the default path, so the request carries admin auth. That also means §18.6's premise
("a plain `<img src>` would not carry admin auth") was wrong.
- The route's own headers govern every way the image is viewed, including *Open image in new
  tab*: the stored mime, `nosniff`, and `default-src 'none'; sandbox`.
- A failed load (the request was decided meanwhile, the file is gone, the session expired)
  becomes a line of text. The error listener is attached by `onRender` in the same task that
  paints the row.
- The admin CSP stays `img-src 'self' data:`, and a test pins it without `blob:`. No
  **Setup nginx** re-run is needed.

The first build used `adminFetch` → blob → object URL, and added `blob:` to the admin CSP. It was
switched the same day, on security grounds: an object URL is a copy of the bytes on the admin
page's origin and does **not** carry the route's sandbox headers. That approach also needed the
CSP widened and an nginx re-run that a code deploy does not perform. What it bought was only
convenience: the server's refusal text, and no refetch on a repaint of a handful of admin-only
images. See design §18.11 *Part 3* #1.

**Tests.** `npm test` **1298 → 1310**, 20 suites, exit 0.
- `test-donor-names.js` 145 → 92. The capture, rescan, `displayState`, censor and new-names
  blocks were deleted with the code. Added: the new separators, the flag tests (including 300
  names × 4,000 entries), a "removed API stays removed" block, and the `donor_banner_slots`
  bounds. It also checks that a save carrying `donor_censored_display` is refused.
- `test-donor-league.js` 77 → 72. The name block was rewritten over `donor_requests`: approved
  shows as typed; pending, rejected and removed names never show; a v1 `donor_name` is not read;
  expiry and expiry-0 are covered. A leak sweep checks for pending names and reasons, and
  `censored_display` is gone from the shape.
- `test-donor-profiles.js` 153 → 182, new [9] admin reads:
  - queue order, flags, `current`, and no `image` key or Buffer;
  - the closed status enum, including an array and SQL text;
  - image bytes for pending and approved rows, and the refusals: name row, junk ids, a tampered
    mime, a traversal filename, a deleted file, and a rejected request;
  - block emptying the queue;
  - `adminProfiles` states and expiry parity with `profileFor`.
- `test-admin-guards.js` 79 → 102, [6] rewritten:
  - the tier of all nine routes;
  - censor/uncensor absent, which means 404, and no catch-all;
  - every write delegating to the lib with admin id + ip, with no inline SQL;
  - `GRIN_ADDR_RE`, the closed `kind`, and the two 503s;
  - the image route's four headers and its 404/400;
  - the rescan gone from the settings save;
  - the dashboard and summary counts.
- `test-admin-panel.js` 71 → 90, [9] rewritten, plus a §J14-4 check that `img-src` stays `'self' data:` with no `blob:`. It covers:
  - page order;
  - the settings-id sweep against live defaults, with `donor_censored_display` on no page;
  - `settings-skip` on every input outside the form;
  - `this.dataset` on every action, and `adminFetch` for every write;
  - the in-page dialog, and the reason-is-public labels;
  - the same-origin `src` (id URL-encoded), no object URL or blob anywhere, and a failed load turning into text;
  - the thumbnail URL shape;
  - the queue not polling, and reasons surviving a repaint;
  - escaping;
  - `onRender` being try/caught.
- `test-public-leakage.js` 88 → 87. §9's `displayState` checks were replaced with:
  - the wall reading `publicProfiles`, with no v1 column and no marker anywhere;
  - `publicProfiles` and `profileFor` never selecting `image` or a non-approved name;
  - **an enumerated inventory of every route that touches `donor_requests`**. The public ones
    must be exactly the reviewed five, no public route may call an admin reader, and every admin
    one must be `secureAdmin` / `freshAdmin`. A new public route fails the test until it is
    reviewed;
  - the account route deriving its two name fields from `donor_profile`.

Also run once, not kept in the repo: a jsdom render of `donors.html` with the real
`admin-shell.js` and stubbed `API`/`adminFetch` (26/26 after the switch to a plain `src`). It checked:
- hostile names, flag words, worker names and a `javascript:` banner URL all render as text or
  not at all;
- the same-origin `src` on both banners, with no image going through `adminFetch`, and a failed
  load becoming text;
- a reason surviving a search repaint;
- reject posting the typed reason, and approve / remove / unblock posting;
- Escape cancelling a block;
- `prompt()` never being used;
- no script errors.

#### §18 Part 4 — public wall: `/api/pool/donors` v3 + `donate.html` (2026-09-24, uncommitted)

**The response (v3).** Built in `lib/donor-ledger.js donorWall()`. The route in `index.js` is
unchanged apart from its comment.
- Every card gains `banner`: `{ url, width, height }` or `null`. It is set only on a **league**
  card whose rank ≤ `donor_banner_slots`, and only when the address has an approved, unexpired
  banner (from `publicProfiles`) whose stored width and height are positive integers. Past cards
  are always `null`: they reach the card builder with `rank` null, and the slot test needs a
  safe-integer rank ≥ 1.
- `ranking` gains `banner_slots` (0–10). This is how the page learns N for its Top-N spotlight.
  It is bounded by `bannerSlots()`, now exported from `lib/donor-profiles.js`, so a raw `ds` that
  skipped `donorSettings()` still reads 0–10 rather than NaN.
- `current_percent` is **dropped** from the card. It was a v1 alias of `pct_max`, and
  `donate.html` was its last reader. A grep of `public_html/`, `admin-panel/`, `lib/` and
  `index.js` finds only the comment that records the removal.
- The `API_DOC_META` row for `GET /api/pool/donors` is rewritten to the v3 card list, with the
  banner rule and `banner_slots`. The route comment's v1 phrase "a stored % is dormant" is
  replaced with the per-share wording.

**The page (`public_html/donate.html`).**
- **D-01 is rewritten** per §18.7. The table now has four rows: `rig01-donate10` (this rig only,
  other rigs unaffected), whole-name `donate10`, plain `rig01` (`rig01-donate0` is the same), and
  typos ignored. The note leads with *"To change or stop: rename the rig and restart the miner…"*.
  The `yourbrandname` row, the raise row and the name ceremony are gone.
- **New D-01b "Your donor name & banner"**: where to set it (account page → Donor profile), the
  two proofs (a mining IP *and* the rig's stratum password), reviewed first, and the banner spec
  (800 × 200 recommended, PNG/JPG/GIF, ≤ 300 KB, top N only). Two lines follow the API's
  `ranking`:
  - the banner line: "the top 5 donors", or "Banners are switched off on this pool" at 0;
  - the expiry sentence: N months, or "stay up for as long as the pool keeps them approved" at 0.

  The fallback line ("Can't pass the check? Ask the pool operator.") carries branding.js's
  existing `data-brand="contact-link"`. That link stays hidden when no contact email is
  configured, and the sentence still reads correctly without it.
- **D-03 Top-N spotlight** above the compact league, for ranks 1..`banner_slots`:
  - Rank 1 spans the row and 2..N share the grid.
  - The banner sits in a fixed **4:1 box**: `aspect-ratio: 4 / 1`, the `<img>` absolutely
    filled with `object-fit: contain`, `width`/`height` attributes, `alt` = the name or
    "Donor #N", `loading="lazy"`.
  - A spotlight card without a banner shows the name large in the same box, so the grid stays
    even. Under a banner the name is repeated as text, because a banner may be a logo alone.
  - Ranks N+1.. keep the compact cards. At `banner_slots` 0 there is no spotlight, and the
    whole league renders as compact cards.
- **Card copy (§18.3).** The live line is *"10 % of new earnings from 2 rigs"*; mixed tags give a
  range (*"5–20 %"*), and none gives *"paused — no tagged rig online"*. The meta line is
  *"since 2026-09-21 · 2 rigs donating"*, with the rig count left off when paused. The badge is
  now a sentence-case tag instead of an uppercase pill, so it can wrap at 390 px.
- `nameCell` lost its v1 `censored` branch, and the `.donor-name.censored` CSS went with it. The
  disclaimer now reads *"Names and banners are chosen by donors and reviewed by the pool before
  they appear."*
- **The page keeps its own banner fence.** `bannerOf()` renders an `<img>` only for a URL that
  matches the server's exact file shape (`^/uploads/donors/<16 hex>.(png|jpg|gif)$`), which is
  stricter than the plan's "starts with /uploads/donors/", and only with positive-integer dims.
  The URL and `alt` go through `escHtml`. It is the page's only `<img>`.

**Deploy.** No nginx, deploy-script or schema change. Approved files are served by the existing
`location /uploads/` (verified in Part 2, §18.11 *Part 2* #11). `donate.html` and the backend
ship together in one deploy. A browser holding a cached pre-v3 page would read the missing
`current_percent` as 0 and show "paused" until it reloads.

**Tests.** `npm test` **1310 → 1331**, 20 suites, exit 0.
- `test-donor-league.js` 72 → 86. The shape check is now the v3 card list, `ranking` has five
  keys, and the `current_percent` asserts moved to `pct_max`. A new banner block checks:
  - default 5 slots: ranks 1–5 carry the exact `{url,width,height}`, and ranks 6 and 7 are null
    although their banners are approved;
  - the past strip is null;
  - slots 1, 7 (the boundary card) and 0 (no card anywhere);
  - 99 bounded to 5, and a raw `ds` with junk `bannerSlots` reading 5;
  - pending, rejected, removed, a traversal filename and zero width are all null on top-5 cards,
    with no pending bytes, reason text or `/uploads/` path anywhere in the response;
  - expiry hides a banner, and expiry 0 = never.
- `test-public-leakage.js` 87 → 94, §9:
  - the card builder's `inSlot` guard, verbatim;
  - `slots = bannerSlots(ds)`, and past cards built with rank null;
  - no `current_percent` in the card;
  - `donate.html` carries no v1 copy (`yourbrandname` / `ceremony` / "go through donate0" /
    `censored`) and no `current_percent`;
  - `donate.html` renders an image only through `bannerOf()` with the exact regex, as its single
    `<img>`;
  - names and `alt` go through `escHtml`.

Also run once, not kept in the repo: a **390 px iframe probe**, as in the v1 method (impl §10.3
*Part 4*). It used a throwaway Node server on 127.0.0.1 with stubbed `/api/*`, generated PNG
banners at 4:1, 8:1, 2:1, 320×80 and 1200×300, and headless Edge with `--screenshot`. The page
POSTed its measurements back, because Edge on Windows has no stdout for `--dump-dom`. The server
and every headless Edge process were killed in-session.
- **Fixtures:** 0 banners, 1 banner (8:1), 5 banners, slots 0, and a hostile set (an
  `<img onerror>` name, a `javascript:` banner URL, a `..` URL, zero width).
- **At 390 px, both the Reactor (dark) and Light themes:** `docWidth` 375 (= 390 − scrollbar)
  and **0 elements past the right edge** in all five fixtures. Every banner loaded into a 291×73
  box. The hostile fixture rendered the name as text, with no `<img>` and no `onerror` attribute.
  The D-01b slot, expiry and contact lines followed the fixture.
- **At 1280 px, dark:** 0 overflow. Rank 1's box is 1064×266 and ranks 2–5 sit four across at
  242×61.
- Both theme screenshots were read by eye, and the ink is legible in each.

#### §18 Part 5 — account page: donation row, rig badges, Donor profile panel (2026-09-24, uncommitted)

**The page (`public_html/account-settings.html`).**
- **P-05 donation row** (`renderDonationRow`). It reads `donation`:
  - With a tagged rig online: *"10 % of new earnings from 2 of 5 rigs online"*. Mixed tags show a
    range (*"5–20 %"*).
  - The second line names the donating rigs, with each rig's % when they differ (six names, then
    *"+N more"*).
  - An address that has donated before (`donor_profile.eligible`) but has no tagged rig online
    reads *"paused — no tagged rig online"*. Anyone else sees no row.
  - The tooltip states the per-rig rule and "rename + restart". The v1 ceremony text is deleted.
  - A *"Donor profile ↓"* link jumps to P-09 while it is visible.
- **P-03 badge.** A *"donates 10 %"* tag sits beside each rig whose `donate_percent` is above 0
  (`donateBadge`). Both workers windows are merged by name, as before.
- **NEW P-09 Donor profile** (`renderDonor`, from `donor_profile`):
  - **A lead line** for each refusal: donations off, blocked, or *"Donate from any rig to
    unlock"*. An eligible donor gets the intro, which says the reason for a refusal is shown on
    this (public) page.
  - **A two-proof gate.** It uses its own `dp-ip-proof` / `dp-pass-proof` inputs, restating the
    Goblin card's labels and help for this purpose.
  - **Two columns, name | banner**, each with state lines: showing, expired, waiting for review
    (+ UTC time), not approved (+ reason), taken off by the pool (+ reason), or none. Then the
    form and the Submit / Withdraw / Remove buttons.
  - **The banner column** also shows the approved banner in the wall's 4:1 box, through the
    exact-shape URL fence `DP_BANNER_URL_RE`. It says *"Showing — #2, inside the top 5"*,
    *"#8 — shows while you're in the top 5"*, *"not ranked in the donor league right now"*, or
    that banners are switched off.
- **Banner upload.** Picking a file does this in order:
  1. Size check (300 KB), which blocks.
  2. Magic-byte sniff of the first 16 bytes, the same three signatures as `SNIFFERS`, which
     blocks.
  3. A `data:` URL preview in the same 4:1 box, with the header dims as a **warning only**.

  It is sent as multipart, with the two proofs as text fields and the file named `banner`.
- **Pending content** comes only from the POST response, kept in the tab (`dpMine`) while
  `pending_at` still equals its `submitted_at`. After a reload the page shows the time only.
- **Removing a live item** arms on the first click (6 s) and acts on the second. Withdrawing
  a pending request is one click.
- **Errors** are the server's `error` sentences. The terse proof codes, including `wrong_kind`
  (the right proof in the wrong box — `match` until the Part 6 review renamed it), map to
  sentences in `DP_REASONS`, so no raw code is shown.
- **After a success** the page re-reads only the summary (`dpRefresh`) and clears both proof
  boxes. `dpReset` clears proofs, file, messages and pending text when the address changes or
  the demo loads.
- **DEMO**: `ipollo-01-donate10` (badge + "1 of 2 rigs"), an approved name, and a banner waiting
  for review at rank 3 of 5.

**Backend (`index.js`).** The account route drops `donation_percent`, `donor_name` and
`donor_name_state`, along with the `donor` helper that derived the pair; the api-docs row follows.
Nothing else changed. The miner routes and `profileFor` already carried every field §18.6/§18.8
need.

**Tests.** `npm test` **1331 → 1343**, 20 suites, exit 0.
- `test-donor-profiles.js` 182 → 187. The page's `DP_NAME` / `DP_BANNER` equal the lib's
  `NAME_MIN` / `NAME_MAX` / `NAME_CHARSET_RE` / `BANNER` / `MAX_BANNER_BYTES`. The page's own
  `dpCheckName`, evaluated from its source, agrees with `validateName` over a 19-name matrix
  (NBSP, RTL override, emoji, tabs, 32/33 chars, separators only) and sends the same normalised
  name.
- `test-public-leakage.js` 94 → 101. The account route sends `donation` + `donor_profile` and no
  v1 alias, and the api-docs row drops them. The page:
  - has no v1 copy and reads no dropped alias;
  - shows a live banner only through the exact-shape regex;
  - builds previews with `readAsDataURL` (`createObjectURL` only in the proof download);
  - clears both proof boxes on all three success paths;
  - never reads a pending name from the API.

Also run once, not kept in the repo: a **390 px iframe probe** with the Part 4 method. It used a
throwaway Node server on 127.0.0.1 that exits by itself, stubbed `/api/*`, a generated 1600×200
(8:1) PNG, and headless Edge with `--screenshot`. The measurements were POSTed back. Nothing was
left running afterwards (process sweep).
- **Fixtures:**
  - **A**: eligible, name showing, a rejected rename whose reason carries an
    `<img onerror>`, an approved 8:1 banner showing at #2 of 5, and mixed 5–20 % tags from 3 of 5
    rigs with long names.
  - **B**: never donated.
  - **C**: blocked and paused, name expired with a rename pending, banner removed by the pool with
    a long reason.
  - **D**: the built-in demo.
- **Reactor (dark) and Light, all four:** `docWidth` 375 and **0 elements past the right edge**.
  Each fixture showed the intended buttons and forms: B has no body, and C offers only
  Withdraw/Remove. The 8:1 banner letterboxed in a 311×76 box. The hostile reason rendered as
  text: no `<img>` in the panel, and no script ran. Screenshots of A-light and C-dark were read by
  eye, and the ink is legible.
- A copy tweak after the probe removed the doubled "not approved" wording. That changes text
  only, and `npm test` was re-run after it.

#### §18 Part 6 — independent review (2026-09-24, uncommitted)

A separate cold session read §18 and the working-tree diff, answered every §18.9 point with
evidence, and ran three one-shot scratch harnesses outside the repo (a per-share distribution on a
stub DB with the reconciliation invariant, a banner-parser fuzz, and the route inventory). The
answers and findings are in design §18.11 *Part 6*. What it changed:

- **One fix: `wrong_kind`.** `requireBothProofs` refused a proof that verified as the *other*
  kind with the verifier's own success code, `match`. So both the response and the
  `auditOwnerProof` row read `ok:false, reason:'match'`. The code is now `wrong_kind`, on the
  donor routes and the Goblin route alike. The refusal **text** did not change, so the Goblin
  strings stay byte-identical. The account page's `DP_REASONS` key was renamed to match.
- **Tests first.** `test-donor-profiles.js` gained two checks, one for the gate and one for the
  page map. Both failed before the edit and pass after it. `npm test` **1343 → 1345**, 20
  suites, exit 0. `bash -n scripts/07_grin_mining_public_pool.sh` OK.

### 10.7 Operator-selectable chain explorer — `branding.explorer_mainnet` (2026-09-24, add-ons — NOT VPS-tested)

**Origin:** every block height, block hash, kernel and output the pool shows links out to a public
Grin explorer. That link is the miner's independent proof. Until 2026-09-23 the explorer was
hardcoded (`DEFAULT_EXPLORER` in two browser files, plus `explorerBlockUrl()` in `index.js`). That
day the mainnet default moved from `scan.grin.money` to `grincoin.org`, which took a code edit in
three places. The explorer is now an **admin setting**, so a dead explorer can be swapped from the
panel. The work ran as backend, frontend, a cold review and this docs fold. **None of it has run
on a VPS.**

#### The setting

- **Settings → Branding → Chain Explorer**, `<select id="explorer_mainnet">`, stored as
  `branding.explorer_mainnet`. It is an **enum of exactly three keys, default `grincoin`**:

  | Key | Host | block (height) | block (hash) | kernel | output |
  |---|---|---|---|---|---|
  | `grincoin` (default) | `https://grincoin.org` | `/block/<h>` | `/hash/<hash>` | `/kernel/<ex>` | `/output/<c>` (unspent only) |
  | `tiny` | `https://scan.grin.money` (06d) | `/block/<h>` | `/block/<hash>` | `/kernel/<ex>` | `/output/<c>` |
  | `grinscan` | `https://grinscan.org` (06b) | `/block.html?h=<h>` | `/block.html?h=<hash>` | `/kernel.html?ex=<ex>` | `/output.html?c=<c>` |

- **Testnet is fixed** on `https://test.grinscan.org` (query style, key `grinscan_testnet`) and
  ignores the setting. Only grinscan has a usable testnet explorer: `testnet.grincoin.org` is
  pruned, so old blocks fail there, and `testnet.grinscan.org` is NXDOMAIN. On a testnet pool the
  select is greyed out, and the help line changes to say every link opens test.grinscan.org.
  `grinscan_testnet` is deliberately **not** a mainnet choice.
- **Validation** (`validateMainnetChoice`, wired into `lib/pool-settings.js` `validators.branding`)
  is an exact match: no trim and no case folding, so `' grincoin'`, `'GRINCOIN'`, a URL or a
  non-string is refused with a readable error, and the whole section save rolls back. `branding`
  is not a step-up section, so no second factor is needed. The save writes the ordinary
  `update_settings` audit row. Like every settings save, that row lists `changed_keys` (names
  only, never the old → new values, audit §J1-2), so a reader sees *that* `explorer_mainnet`
  changed but not to what.

#### How a key becomes a link

1. **One server registry, `back-end-pool/lib/explorers.js`** (new, pure, frozen): `STYLES`
   (`path` / `grincoin` / `query`), `EXPLORERS`, `MAINNET_CHOICES`, `DEFAULT_MAINNET`, `TESTNET`,
   `resolveExplorerKey(network, stored)` and `explorerUrl(key, kind, value)`.
2. **The server publishes the RESOLVED key, never the raw setting.**
   `resolveExplorerKey` returns `grinscan_testnet` on testnet. On mainnet it returns the stored
   value only if it is a string that `MAINNET_CHOICES.includes()`; otherwise it returns
   `grincoin`. That covers unset, `''`, a corrupt DB row, `__proto__` / `constructor`, and
   `grinscan_testnet`. The resolved key goes out as `explorer` beside `network` on the three
   routes that prime a page's network cache:
   - `GET /api/public/branding` → `connection.explorer`, which `branding.js apply()` reads.
   - `GET /api/pool/stats` → `explorer`, which admin-shell `decoratePoolIdentity()` reads.
   - `GET /api/config/pool-info` → `explorer`, which public `blocks.html` reads before its first render.

   `buildPublicConfig()` also publishes `branding.explorer_mainnet`, again resolved as mainnet:
   that is the operator's choice as made, and on a testnet pool it differs from
   `connection.explorer`. **Links follow `connection.explorer`.** All three routes' `API_DOC_META`
   rows describe the new key.
3. **Two browser mirrors of the registry**, `public_html/js/branding.js` and
   `admin-panel/admin-shell.js`, each back `window.Explorer`
   (`url` / `link` / `network` / `key` / `relink`). A primer caches the key in
   `sessionStorage['pool-explorer']` next to `'pool-network'`, and removes it when a response
   carries no key. `explorerKey()` **re-applies the resolve rule on the client**:
   - testnet → `grinscan_testnet`, whatever is cached, so a stale mainnet key from another tab
     can't leak onto a testnet pool;
   - otherwise the cached key if it is in `MAINNET_CHOICES` and is an own registry entry, else
     `grincoin`;
   - a `sessionStorage` that throws (private mode) also gives the network default.

   A key is only ever looked up in the registry. A published value is never used as a URL, so a
   path style always travels with its host.
4. **`/api/admin/blocks`** builds `grinscan_url` through `explorers.explorerUrl`. The field name
   is legacy and kept for API shape; it holds whichever explorer the setting resolves to.

**Link sites** (all through `Explorer.link`, which `xEsc`-escapes URL and label, adds
`rel="noopener"`, and `encodeURIComponent`s the value):
- public: `blocks.html` height + *view* column, `reactor-dashboard.js` `#height` and the tip,
  the `fortune-board.html` seed cell, `account-settings.html` ledger block rows and the
  withdrawal *Proof* column;
- admin: `blocks.html` and `health.html`.

#### Review fix — links rendered before the primer lands (Part 3)

A page's own fetch can beat its primer. Examples: branding's fetch against reactor-dashboard's
`loadStatus`, fortune-board's winners and the account ledger, or `decoratePoolIdentity` against
every admin page's fetch. `sessionStorage` is per **tab**, so every new tab counts as a first
visit. Those early links took the `mainnet` + `grincoin` fallback, and nothing re-rendered them.
On a testnet pool that meant test heights opened on grincoin.org (mainnet), and a mainnet pool
set to `tiny` or `grinscan` showed grincoin links anyway.

**Fix:** `link()` tags each anchor with `data-xp-kind` / `data-xp-ref`, and both primers call
`Explorer.relink()`, which re-points every tagged anchor through `explorerUrl()`. The host still
comes from the registry and the ref is re-encoded, so an attribute value never becomes the URL.
The review also corrected the plan's acceptance step, which expected old → new values in the
audit row. It records key names only, deliberately (above).

#### Propagation delay after a save

The server memo is dropped at once: the settings save and restore routes both call
`invalidateBranding()`. `/api/public/branding` is still served with `Cache-Control: public,
max-age=60`, and the primers rewrite `sessionStorage` on every page load. So an open browser
switches explorer on its **next page load after up to ~60 s**, and a hard refresh switches it
sooner. Operators should expect a delay of about a minute. It is not a bug.

#### Decided against

- **A free-text URL.** The three sites use different path schemes, so a typed host would bring
  back the 2026-07-25 bug where every grinscan link 404'd. A compromised admin panel could also
  point every miner's proof link at a fake explorer that confirms whatever the pool claims.
- **A "test this explorer" button.** grincoin.org answers HTTP 200 for every path, its error
  page included, so a status probe would call a dead explorer healthy.
- **Accepted caveat:** on 2026-07-25 `scan.grin.money` and `grinscan.org` resolved to the same
  Cloudflare IP and the same Express origin. If both still run on the operator's VPS, `tiny` and
  `grinscan` fail together, and the default `grincoin` is the independent choice.

#### Tests

`scripts/test-explorers.js` (new, last in `test:unit`) runs **198 checks**. They cover:
- every key × kind URL, including grincoin hash → `/hash/`, and URL-encoding of `1/../x` and `"<>`;
- `resolveExplorerKey` against every junk and prototype value;
- the validator;
- a `PoolSettings` round-trip on a throwaway SQLite file: default, the audit row naming the
  key, rollback on a refused value, a corrupt row still publishing `grincoin`, and Restore
  Defaults;
- the three routes publishing the resolved key, and `explorer_mainnet` not being step-up;
- **registry parity**: the `EXPLORERS` / `STYLES` / `MAINNET_CHOICES` literals in both browser
  files must equal `lib/explorers.js`, and `window.Explorer.url()` in each must equal
  `explorerUrl()` for every network × cached key (garbage, prototype keys, a stale mainnet key
  on testnet, a throwing `sessionStorage`);
- the three primers;
- the Branding select: exactly three options, and greyed out on testnet whether the network was
  already known or arrives later;
- the relink fix.

⚠ **Change a base or a segment in one of the three registry copies and this suite fails, so
change all three together.** On 2026-09-24, `npm test` exited 0 with `test-explorers.js` at
198/198.

**VPS acceptance is still owed.** Run testnet first, then mainnet: the select disabled on testnet
while Branding still saves; each of the three keys producing working block and kernel links on
mainnet, judged by page content and not by status code; the admin Blocks *view* column following
the setting; and a tampered DB row falling back to grincoin.org.

### 10.8 Tor payout hardening — F1–F5 + the exit-0 fallback (2026-09-25, add-ons — NOT VPS-tested)

> **Ladder and stepwise superseded 2026-09-26 by §10.10 (one attempt, then an answer).** Still
> current: **F1** (a kernel only once confirmed), **F2** (the `payout_unmined` watchdog and its
> CLI repost), **F4** (the deleted auto-payout keys) and the **exit-0 fallback** detection. Outcome
> B now uses the fallback's cancel as proof of absence and refunds at once, instead of retrying.
> **Gone:**
> - **F3.** The shortfall retry and the whole ladder. A shortfall is now outcome C: `pool_busy`,
>   refunded on proof.
> - **F5.** The stepwise sender, `tor_send_mode`, `pool_tor_unavailable` and `payout_tor_stepwise`.
>   `_dropStepwiseSlate` and the two inert columns stay.
> - **The review's fix 2 still holds** (the freeze is re-read per row). Its fix 1 survives as
>   `_dropStepwiseSlate`.
>
> The *Still open* list at the end is history, except: the watchdog `Standard1` class, the
> mainnet check for `confirmed` rows with an unconfirmed `TxSent`, off-box delivery, and the
> missing `max_pending_withdrawals` / `max_user_pending` validator. The rest below is left as the
> 2026-09-25 record.

**Origin.** On 2026-09-24 the operator asked: "Tor is unstable, how do we protect the wallet and
avoid double-spend?" A read-only review of the Tor payout path found that the existing rule
already holds: **never refund and never re-send unless the wallet proves the earlier attempt is
absent; if the answer is unknown, park the payout and keep the amount locked.** It also found five
gaps (F1–F5), and the operator approved all five on 2026-09-25. Building F5's design turned up a
sixth, worse gap in the shipped CLI rail. Another session fixed that one the same day.

Everything here is in the `add-ons` working tree, **uncommitted**, and **has never run on a
VPS**. Two steps are still owed: an independent review of the whole change, and VPS acceptance,
testnet first and then mainnet.

| # | Gap | Fix | Where |
|---|---|---|---|
| F1 | The kernel link and "paid · mined" could appear before the tx was mined | The kernel backfill stores a kernel only from a **confirmed** tx-log entry | `lib/withdrawal-scheduler.js` `backfillKernelProofs` |
| F2 | "Paid" meant the send command succeeded, and nothing watched for a tx that never mined | Watchdog: `payout_unmined` alert, admin `chain_state`, one safe CLI repost per hour | scheduler, `lib/wallet-tor.js` `repostTx`, `index.js`, `health.html`, `payments.html` |
| F3 | A pool-wallet shortfall waited 6 h or more and used up a retry | Shortfall retries after 1 h and does not count, capped at 24 | scheduler `scheduleRetry` |
| F4 | "Enable automatic payouts" and "Auto Payout Frequency" did nothing | Both keys and both inputs deleted | `lib/pool-settings.js`, `settings-payout.html` |
| — | **The CLI rail marked an undelivered Tor send PAID** (found by the F5 design) | Only `Tx sent successfully` counts as sent; the fallback slate is cancelled before the retry | `lib/wallet-tor.js` `classifySendOutput`, scheduler `_releaseTorFallback` |
| F5 | The Tor rail learned its slate id only after the send | Step-by-step Tor send through the Owner API, behind `tor_send_mode` (default `cli`) | `lib/wallet.js`, `lib/wallet-tor.js`, scheduler, `lib/db.js`, settings, `index.js` |

**Tests.** `npm test` was re-run while this section was written: exit 0, 21 suites. The five
suites this work touched stand at: `test-payout-guard.js` **220**, `test-payout-rails.js`
**122**, `test-admin-guards.js` **128**, `test-admin-panel.js` **105** and
`test-public-leakage.js` **108**. Each count matches the build sessions' own reports. The
build sessions also report that every new check was run against the code with its fix removed
and failed there. That claim is **theirs, not re-checked here**. Part 6 alone reports 35 such
mutations, each caught by at least one failure.

#### F1 — a kernel is stored only once the tx is seen mined

`backfillKernelProofs` copied `kernel_excess` from **any** tx-log entry that matched the row's
slate id. So a posted but unmined tx could light up "paid · mined" and an explorer kernel link
that opened a "not found" page. It now requires `t.confirmed === true`, as well as a slate id and
a kernel. The 3-minute throttle and the 30-day window are unchanged.

The build session settled which of two contradictory comments in the scheduler was right, by
reading the grin-wallet v5.4.1 source:

- The tx log's `kernel_excess` is written at **`tx_lock_outputs`**
  (`libwallet/src/internal/selection.rs` `lock_tx_context`). At that point it is the
  **sender-only partial excess**, not the final kernel.
- It is rewritten at **finalize** (`internal/tx.rs` `update_stored_tx`, called from
  `api_impl/foreign.rs` `finalize_tx` before `post_tx`).
- Confirmation (`internal/updater.rs`) never writes it.

So the comment "populated once the tx mines" was the wrong one, and a kernel in the tx log proves
nothing about the chain. Only `confirmed` does.

**The invariant later work relies on:** on a `confirmed` row, `kernel_excess IS NULL` means
"not yet seen mined", or that there is no slate id or no Owner API to ask. This holds only for rows
written after the fix. Rows filled earlier were left alone on purpose. The pool has run only on
testnet, so such a row could carry an unmined kernel, and the F2 watchdog cannot see it.

No API or UI text changed. `payment-history.html`'s "paid · sent" tooltip and the
`has_kernel_proof` descriptions were already literally true once the kernel means "confirmed".
Tests: `[kernel-proof]` in `test-payout-guard.js`.

#### F2 — the "marked paid but not mined" watchdog

A payout reaches `confirmed` when the send succeeds, not when the tx mines. A Grin node drops its
mempool on restart, so a posted tx can vanish. The miner then sees "paid" with nothing received,
and the pool wallet's inputs stay locked in an unconfirmed `TxSent`, which can itself cause a
shortfall. Reconciliation's `auditWalletSends` checks the **opposite** direction: a confirmed
wallet send with no pool row. The watchdog checks a pool row with no confirmed wallet send.

- **Where it runs.** In the scheduler loop, on the **same** `getTransactions(true)` call as the
  kernel backfill, under the same 3-minute throttle. It adds no node round trip, and it is
  read-mostly, so it runs while payouts are frozen.
- **Candidates.** Rows that are `confirmed`, have no kernel, were marked paid more than
  `UNMINED_ALERT_S` (3600 s) ago, and were created within 30 days. All three rails are covered.
- **Classes**, by the row's slate id in the tx log:

  | Tx log shows | `chain_state` | Alert level |
  |---|---|---|
  | confirmed | `mined` (once the kernel backfill stores the kernel) | — |
  | paid under an hour ago | `settling` | — |
  | `TxSent`, not confirmed | `unmined` | warning |
  | no slate id captured | `unverifiable` | warning |
  | `TxSentCancelled` | `cancelled` — the miner was debited and **not** paid | **critical** |
  | no entry for the slate | `absent` | **critical** |

- **The alert.** One rolling `alerts` row of type `payout_unmined`, updated in place while it is
  active and resolved by the first tick that finds nothing overdue. Its message lists withdrawal
  ids, slate ids and UTC ages, capped, with critical rows first. The data carries a short runbook.
  It is written through a new shared `_rollingAlert(type, level, message, data)`, which
  `_noteWalletShort` now uses too, with identical behaviour. The alert is stored in the DB only.
  **It is not pushed off-box:** AlertMonitor delivery is not wired (§J8-3).
- **The health card.** `/api/admin/health` folds the active alert into the Grin Wallet card. A
  warning downgrades an OK card to Degraded. A critical sets a new **`critical`** status, which
  `health.html` shows as a red **Critical** badge, because the service is up but wrong and must
  not read as "Down". An `error` (wallet down) is never masked.
- **Admin payments.** `GET /api/admin/withdrawals` adds `chain_state` per row. `payments.html`
  shows it as a badge beside "Paid", with a tooltip for each class. No public route carries it.
  `test-public-leakage.js` asserts this. `chainStateOf` reads the watchdog's last scan from
  memory, so for up to one tick after a restart an overdue row reads `unmined`. That is still
  literally true: the row is not yet *seen* mined.
- **The repost.** For the `unmined` class only, the pool re-broadcasts the **stored** finalized tx
  with the CLI, `grin-wallet repost -i <tx log id> -f` (`WalletTor.repostTx`). It does this at
  most once per row per hour (`REPOST_EVERY_S`), at most 3 rows per tick, and at most 24 times in
  a row's life. It is keyed on `repost:` event notes and skipped while payouts are frozen. It
  cannot pay twice: it is the identical transaction, with the same inputs and kernel, so the chain
  takes it at most once. It never builds a new tx, never cancels, never refunds and never changes
  a status. After 24 it stops and logs that a human is needed.
- **Why the CLI and not Owner v3.** The plan named `get_stored_tx → post_tx`. The build found that
  over JSON-RPC `get_stored_tx` returns a V4 slate with `sigs: []` (`api_impl/owner.rs` builds a
  blank slate that carries only `tx`), and `post_tx` rebuilds the kernel from `sigs` alone
  (`libwallet/src/slate.rs` `tx_from_slate_v4`). That route would post a zero kernel. The CLI
  keeps the slate in-process, and it refuses a tx that is confirmed or was never finalized
  (`controller/src/command.rs` `repost`). **So never round-trip a stored tx through JSON-RPC and
  post it.** `finalize_tx`'s own return value does carry the sigs and is fine.
- **No refund route was added.** For a `cancelled` or `absent` row, the operator checks the node,
  reposts, or, once the wallet proves the tx is gone, refunds by hand. Settling such a row
  automatically in either direction is exactly what the money rules forbid.

Tests: `[unmined]` in `test-payout-guard.js`. `test-admin-panel.js`'s STATUS-set regex was scoped
to its own block, because the new `CHAIN` map matched it.

#### F3 — a pool-wallet shortfall retries in 1 h and does not count

When grin-wallet refuses a Tor send with `NotEnoughFunds`, the cause is usually outputs held by
other payouts that are still settling, and it clears within the hour. It used to take the
miner-offline ladder (6/12/24/48 h) and use up a rung, so four shortfalls in a row reached
`markFailed` and refunded a payout that had never left.

- `scheduleRetry(id, 'pool_wallet_short')` now retries after `SHORTFALL_RETRY_S` (3600 s) with
  `retry_count` unchanged. This check runs **first**, before the ladder-exhausted test, so a
  shortfall on the last rung takes an uncounted retry instead of `markFailed`.
- The update is guarded (`WHERE status = ?`) and writes its event in the same transaction. The note
  reads `shortfall: pool wallet short, retry k/24 (not counted) at <ISO>`.
- The count is `COUNT(note LIKE 'shortfall:%')` over the row's whole life, cumulative and not
  consecutive. At `MAX_SHORTFALL_RETRIES` (24, about a day) the scheduler logs a `console.error`
  and falls through to the normal ladder. That consumes a rung and waits 6 h, and `retry_reason`
  stays `pool_wallet_short`. So a pool that is simply underfunded does not hold a miner's balance
  forever. The existing last-rung guard decides in the end.
- **The double-send guard is unchanged.** An uncounted retry is still a re-attempt, because
  `priorAttempts` comes from the event log. A test pins it: `retry_count` 0 and slate NULL, with an
  unconfirmed match, defers and does not send.
- **The admin retry route** zeroes `retry_count` but not the shortfall count in the event log. So
  a row re-queued by hand after using its 24 goes straight to the ladder on its next shortfall.
  That is by design: the operator re-queued a pool that is already known to be short.
- The miner's pending strip already reads "queued and will be retried automatically … · next
  attempt HH:MM". For a shortfall that time is now about an hour ahead.

Not fixed, and out of scope: `payout.withdrawal_retry_delays` is still shadowed (audit §J9-8).
Tests: the end of `[retry-reason]` in `test-payout-guard.js`.

#### F4 — the dead auto-payout settings are deleted

`payout.auto_payout` and `payout.payout_frequency` had inputs in admin → Payout, and nothing read
either one. Both inputs, both defaults and the `payout_frequency` validator were removed in **one**
change, exactly as D4 was: the harvester sends every id in `.settings-form`, and `updateSection`
throws on an unknown key. A removal comment sits in `defaults.payout`.

A pool that already stored either key keeps working. `getSection` still merges stored rows over
the defaults with no membership check. The save harvests only ids that are on the page, and
`populateForm` skips keys with no element. The stored rows stay, inert, with no migration.
`test-admin-guards.js` `[7]` proves this against a DB holding `auto_payout='true'` and
`payout_frequency='daily'`: the section loads, a save of the real form succeeds, no audit row
names either key, and sending either key now throws *Unknown key*. `test-admin-panel.js` `[10]`
pins the Payout form ↔ defaults parity. The only defaults with no field on the page are
`dormancy_policy_effective_at` and `withdrawal_retry_delays`.

#### The exit-0 slatepack fallback is no longer marked paid

The F5 design (design §8.1.1) found this in the grin-wallet source, and another session fixed it
the same day. `grin-wallet send -d grin1… -a N` **exits 0 when the Tor delivery fails**. It falls
back to a slatepack: it locks the outputs, writes `<wallet>/slatepack/<uuid>.S1.slatepack`, prints
the slatepack and returns `Ok`. That holds in both v5.4.1 and v5.5.0. The pool read exit 0 as
sent and called `markConfirmed`, so the miner was debited and received nothing, and the locked S1
held its inputs until someone cancelled it.

- `lib/wallet-tor.js` `classifySendOutput` returns `sent`, `slatepack_fallback` or
  `unrecognised`. Only the anchored `Tx sent successfully` line means sent, and it is tested
  **first**, so a posted tx is never classified as a fallback and cancelled.
- On a fallback, `sendToTorAddress` returns `success:false` with the slate id parsed from the
  `.S1.slatepack` path. `_releaseTorFallback` cancels exactly that slate before `scheduleRetry`.
  Cancelling is safe because only the sender finalizes. Without the cancel, the retry's
  double-send guard would read the locked `TxSent` as unconfirmed and defer forever.
- If there is no parsable id, or the cancel fails, nothing is guessed. The row parks and the guard
  defers it. Unrecognised exit-0 output counts as a failure and is never cancelled.

Tests: +12 in `test-payout-rails.js` and +11 in `test-payout-guard.js`. Audit roll-up note "Tor
rail marked a failed send paid".

#### F5 — step-by-step Tor send, behind `payout.tor_send_mode` (default `cli`)

The design and its failure matrix are **design §8.1**. It is now built as designed, with the
deviations listed below. With `tor_send_mode = cli`, which is the default, the CLI rail behaves
exactly as it did: `sendWithdrawal` was not edited by this part.

- **Switch.** `payout.tor_send_mode` is `cli` or `stepwise`. It is a `<select id="tor_send_mode">`
  in admin → Payout. The validator accepts those two values after trim and lowercase and throws on
  anything else. It is applied on a backend restart. `stepwise` without an Owner-API wallet runs
  `cli` and logs an error at start. Two config-only knobs, not admin settings:
  `tor_send_connect_timeout_ms` (30000) and `tor_send_receive_timeout_ms` (60000).
- **`lib/wallet.js`.** `init_send_tx`, `tx_lock_outputs`, `finalize_tx`, `post_tx` and
  `cancel_tx` now go out with **named** params. The Slatepack and Goblin rails share them, and
  their tests stayed green. `initSendTx` takes `paymentProofRecipient` and uses a 60 s per-call
  timeout (`_call(…, { timeoutMs })`; the default stays 10 s). `ttl_blocks` stays `null` **on
  purpose**: the wallet auto-cancels an unconfirmed past-TTL tx, posted ones included. New
  `withSendLock(fn)` is an in-process mutex. The Slatepack and Goblin create paths wrap their
  init → lock in it, so two in-process sends cannot select the same coins.
- **`lib/wallet-tor.js`.** `postJsonRpcOverSocket` generalises the probe's request.
  `checkVersionOverSocket` is now a thin wrapper around it with identical limits. `deliverSlate`
  runs `check_version` and requires Foreign API ≥ 2 and `V4`. It then sends `receive_tx` with
  params exactly `[S1, null, null]`, **positional by design**: it is the miner's Foreign API, and
  that is what the CLI sends. It returns `{ ok, slate }` or `{ ok:false, ourSide, requestWritten,
  reason, detail }`. One retry on a fresh circuit is allowed before `receive_tx` and never after.
- **`lib/db.js`.** Two new columns, `withdrawals.tor_step` and `withdrawals.tor_final_slate`,
  both `TEXT NULL` with a guarded ALTER. There are **no new statuses**: the row stays
  `tor_sending` for the whole attempt.
- **The scheduler.** `checkTorAndSend` dispatches to `sendWithdrawalStepwise` or `sendWithdrawal`.
  - The attempt walks `tor_step` through `claimed → initiated → locked → delivering → finalizing →
    posting`. Every move is a guarded write.
  - `slate_id`, the fee and a `slate: <uuid> created (stepwise)` event are written in one
    transaction **before** `tx_lock_outputs` and before any network I/O. The freeze is checked
    before delivery and before post.
  - `_stepwiseCancelThen` cancels **strictly before** any requeue or retry, and refuses to cancel a
    row at `posting`.
  - A delivery failure on the pool's own side (its tor is down) takes the new uncounted reason
    `pool_tor_unavailable`: 900 s, `tor-down:` notes, cap 24, then the ladder. It is the F3
    pattern.
  - The stale sweep gains a stepwise branch, `_reclaimStaleStepwise`. It re-posts a `posting` row
    at most once per 5 min (`stepwise: repost` notes, cap 24) and never while frozen. It parks a
    contradiction, meaning a `posting` slate that is cancelled or absent, behind a **critical**
    `payout_tor_stepwise` alert.
  - `_stepwiseReattemptGuard` looks up every journaled slate exactly before a new slate is created.
    It also runs `_priorSendLanded` when the row has CLI history.
  - Ids of live attempts sit in `_liveStepwise`, so the sweep never races one.
- **`index.js`.** `tor_final_slate` is stripped from `GET /api/admin/withdrawals` and
  `/api/admin/miners/:addr`, because it is a complete signed transaction. `tor_step` stays, since
  it tells the operator where a `tor_sending` row stopped. No public route changed, and
  `test-public-leakage.js` `[F5]` asserts that neither column appears on one.

**Deviations from design §8.1:**

- **(a)** A row counts as stepwise when its newest **claim** event is stepwise, that is, the newest
  move into `tor_sending` from another status. It is not the newest `to_status='tor_sending'`
  event. Progress events are journaled `tor_sending → tor_sending`, and a `slate:` note would
  otherwise hide the marker.
- **(b)** For the same reason, the stale sweep's age counts claim events only. That gives the same
  result for CLI rows. Without it, every repost pushed the next sweep 10 min out and masked the
  5-minute re-post rate.
- **(c)** The sweep requeues a pre-`posting` row **without** a cancel when the tx log already shows
  its slate as `TxSentCancelled` or absent. `cancel_tx` errors forever on those. This is the case
  where the process crashed between the cancel and the requeue.
- **(d)** An unreadable tx log before a stepwise re-attempt **defers**. On the same condition the
  CLI rail proceeds, loudly.
- **(e)** and **(f)** are test and route plumbing: payout-rails `d. (retry)` now uses
  `retrievePaymentProof`, and the admin list keeps its `const { payment_proof, ...rest }` line and
  deletes `tor_final_slate` from `rest`.

**Journal lines for one stepwise payout, in order:**
`[tor-stepwise] withdrawal N: step claimed` → `step initiated — slate <uuid> saved, locking
outputs` → `step locked` → `step delivering` → `step finalizing` → `step posting` → `posted —
slate <uuid>`. If the backend stops after `step locked`, then after a restart plus about 10 min the
sweep logs `stale withdrawal N: …` and puts the row back to `tor_checking`. `grin-wallet txs`
then shows that slate as `TxSentCancelled`, and the next attempt creates a **new** slate.

Tests: `[stepwise]` S1–S16 in `test-payout-guard.js`, and a named-params wire section plus
`[stepwise-transport]` T1–T9 in `test-payout-rails.js`. The transport tests use an in-process fake
SOCKS5 server and a fake Foreign API on `127.0.0.1:0`, closed in `finally`. Also
`test-admin-guards.js` `[8]` (the validator and `applyToConfig`), `test-admin-panel.js` `[10]`
(the select) and `test-public-leakage.js` `[F5]`.

#### Markers and alert types that code keys on

| Kind | Value | Written by | Read by |
|---|---|---|---|
| event-note prefix | `deferred:` | double-send guard deferral (pre-existing) | the unreadable-log path |
| event-note prefix | `shortfall:` | F3 uncounted shortfall retry | the 24-cap count |
| event-note prefix | `tor-down:` | F5 uncounted `pool_tor_unavailable` retry | the 24-cap count |
| event-note prefix | `repost:` | F2 CLI repost | once per hour, 24-cap |
| event-note prefix | `stepwise:` | F5 claim, requeue, post, `stepwise: repost` | stepwise detection, the 5-min re-post rate |
| event-note prefix | `slate: <uuid>` | F5 step 2 | the §8.1.5 re-attempt guard; `_dropStepwiseSlate` (review fix 1) |
| `retry_reason` | `pool_wallet_short`, `pool_tor_unavailable` | `scheduleRetry` | the account page; only `pool_wallet_short` has its own wording |
| `alerts.type` | `pool_wallet_short` (warning) | `_noteWalletShort` | health, Grin Wallet card |
| `alerts.type` | `payout_unmined` (warning / critical) | F2 watchdog | health, Grin Wallet card |
| `alerts.type` | `payout_tor_stepwise` (warning / critical) | F5 stale sweep | **not** on the health card yet; the alerts list only |

Renaming any prefix silently resets a cap or hides a row from the sweep. Grep before changing one.
The review's `cli: cleared stepwise slate …` note is written for the operator and read by nothing.

#### Independent review (2026-09-25) — two fixes, five test gaps closed

A review of Parts 1–6 re-read the diff and reverted each guard in a scratch copy to see whether a
test caught it. It found two bugs. Both had a failing test before the fix. Both fixes are in
`checkTorAndSend`, and `sendWithdrawal` is not edited.

1. **A double pay after switching `tor_send_mode` back to `cli`.** The stepwise rail writes
   `slate_id` before its lock, and a cancelled stepwise slate stays in that column while the row
   waits on the ladder. The CLI rail reads a non-null `slate_id` as this payout's own send. Its
   double-send guard, `markFailed` and the stale sweep therefore looked up only that dead slate,
   found it `absent`, and sent again or refunded. That happened even when an earlier CLI attempt
   (killed at the timeout after it posted) had landed. `_captureTorSlateId` also never overwrote
   the column, so the kernel backfill and the watchdog kept watching the cancelled slate and
   raised a false critical "NOT paid" alert, whose runbook says "credit the balance back or pay
   again". **Fix:** `_dropStepwiseSlate` clears `slate_id` right before a CLI attempt, but only
   when the row's own journal names it as a stepwise slate. It writes a `cli:` event. Before F5 a
   CLI row had no `slate_id` until it settled, so this restores that state. The `slate:` journal
   line stays, so a switch back to stepwise still finds the slate.
2. **A freeze did not stop the rest of a batch that was already running.** The loop checks the
   freeze once per tick. One tick can run up to 10 retries and 5 checks back to back, each up to
   `wallet_send_timeout_ms`, and AlertMonitor freezes on its own timer. **Fix:** the CLI branch
   of `checkTorAndSend` re-reads the freeze for each row. The stepwise rail already checked at its
   claim. The row waits in `tor_checking` and goes out after a resume.

Tests that could not fail before now can: F2's `MAX_REPOSTS` cap (the old case was stopped by the
hourly rate instead) and `REPOST_MAX_PER_TICK`; F5's refusal to cancel a `posting` row (no current
path reaches it, so it is pinned directly), `MAX_STEPWISE_REPOSTS`, and the claim-only stale age.
New cases are `[stepwise]` S17–S19 and `[review]` R1–R5 in `test-payout-guard.js`, which went from
220 to 233 checks. Each was shown to fail with its guard removed. `npm test` exits 0, and every
other suite is unchanged.

#### Still open

- **VPS acceptance.** Nothing above has run on a box.
  The acceptance runs a normal Tor payout (kernel only after `confirmed`), a dropped tx (restart
  the node before it mines), a shortfall, the Payout save on a pool that stored the old keys,
  stepwise end to end with `verify_proof`, a backend stop between lock and delivery, and the
  exit-0 case (a wallet that goes offline between the pre-flight probe and the send). Stepwise
  stays testnet-only until the operator decides otherwise.
- **The watchdog's fallback class.** The recommended watchdog class for a `Standard1` tx (locked,
  never finalized, readable from `tx_slate_state` on v5.5.0 only) was **not built**. The send-side
  fix makes new fallback rows unlikely, but a row paid before it, or one whose cancel failed,
  still reads `unmined` (a warning), and its repost fails every hour until the 24-repost cap.
  **Check the testnet DB now** for `confirmed` Tor rows whose tx-log entry is an unconfirmed
  `TxSent`. Each one is a miner who was not paid.
- **Stepwise payment proof.** The review corrected the comment above `backfillPaymentProofs`: a
  stepwise row requests a proof too. The backfill's `method = 'tor'` query picks it up, but no
  test covers a stepwise proof. Acceptance step 5a (`verify_proof`) is the only check.
- **Seen in review, not fixed.** These are listed in the plan's Part 8 row:
  - `pool_tor_unavailable` shows the miner "wallet unreachable". The wording needs an operator
    decision.
  - The admin cancel route refunds a deferred `retry_scheduled` row with no wallet check. This
    predates this work.
  - `withSendLock` does not cover the CLI rail, which runs as a second process. (Fixed
    2026-09-27: the CLI is this process's own child, so the Tor rail now holds the lock for the
    CLI's whole run — §10.10 *Review fixes* #2.)
  - Reconciliation's unrecorded-send audit leaves out `retry_scheduled` rows. This predates this
    work.
- **Off-box delivery.** None of the three alert types is pushed off-box (§J8-3).
- `payout.withdrawal_retry_delays` is still shadowed, so a shorter ladder set in the DB would not
  apply (§J9-8).
- `max_pending_withdrawals` / `max_user_pending` have no validator. The first real save stores
  `'100'` as a string over the numeric default, and the audit row names both keys as changed
  although nothing moved. It was seen during F4 and left alone because it is out of scope.

### 10.9 Account page payout feedback + one placard number rule (2026-09-25, add-ons — NOT VPS-tested)

Front end only. No route, scheduler or money rule changed. It came from operator feedback on a
testnet payout that the pool parked as "wallet unreachable" 4 minutes after *Check Tor wallet*
had shown ✓.

- **Tor check in colour.** `setTorStatus` sets `.tor-status.is-yes` (green), `.is-no` (red) or
  `.is-unknown` (amber: our tor could not look). "Checking…" and a reset keep the dim default.
- **No bare `#<id>`.** Beside "queued", `#10` read as a place in line. The request's answer is
  now "Payout requested — X ツ will be sent… usually 1–3 minutes". The id appears once, on the
  pending strip, as `payout ID 10`. The Slatepack messages say `payout ID N` too.
- **Pending tile = a status word.** `PENDING_TILE` maps `tor_checking` → Queued,
  `tor_sending` → Sending, `finalizing` → Settling, `retry_scheduled` → Retrying and
  `slatepack_pending` → Awaiting you, followed by the rail's label. It replaced `#10 · tor`.
- **The strip says how long.** `tor_checking` now reads "queued — sending starts within a
  minute" (it WAITS for the scheduler's next 60 s pass; "sending now" was not yet true).
  `tor_checking` / `tor_sending` add "usually done within 1–3 minutes". That is ≤ 60 s to the
  next pass plus the CLI send, which is killed at `wallet_send_timeout_ms` (120 s). A parked row
  adds "the amount stays reserved until then".
- **The page follows an in-flight payout** (`watchPending` / `pollPending`). While the pending
  row is `tor_checking` / `tor_sending` / `finalizing`, the page polls `GET /api/account/:addr`
  every 15 s, for at most 15 min. When the row moves on, it repaints once (summary, both
  ledgers, P-08). It then reports a Tor payout's outcome in `#acct-withdraw-msg`, from the P-08
  row with the same id: confirmed → green "✓ Payout of X ツ sent", `*_failed` → red "balance
  returned", still parked → red "not taken over Tor… next try at HH:MM". The pool-short case
  keeps its own neutral wording (admin-only cause, §10.5 / memory). Parked and slatepack rows
  are not polled. The watch stops on an address change or in demo mode.
- **One placard number rule — NEW `public_html/js/num-format.js`** (`PoolFmt`). A tile shows
  0 → `0.00`, < 1 → 4 dp, < 1,000 → 2 dp, and ≥ 1,000 → `12.34K` / `1.23M` / `1.23B`. Digits
  are truncated, never rounded up, so a tile cannot show more than the account holds. The exact
  figure is the tile's `title`. Tables, ledgers, forms and the min/max chips keep exact figures.
  Used by the account page (balance / locked / paid), `payment-history.html` (six GRIN tiles),
  `donate.html` (`dn-total`), `fortune-board.html` (`fb-total-prizes`), and `branding.js`'s
  `[data-brand="prize-pool"]` hook. That hook said `GRIN` where every tile beside it says `ツ`,
  and it falls back to the exact figure on a page without the file.
- **Account placard sizes by tile, not viewport.** Under `@supports (container-type:
  inline-size)` each tile is a container, and values use `cqi`. The old `clamp(…, 2.7vw, 32px)`
  put a 32 px "345.9303 ツ" into a ~230 px tile at 1392 px, and it clipped on both sides. The
  pending tile is smaller and may wrap.
- **Checked:** `npm test` exit 0; the four pages' inline scripts parse; 14 `grinTile` edge
  cases (truncation, K/M/B, negative, NaN); headless-Chrome screenshots of a patched-demo copy
  at 1392 px and in 390 / 390 / 760 px iframes. Nothing clipped, and "Awaiting you · Slatepack"
  wraps to two lines. The polling and outcome messages have **not** been run against a live
  backend.

> *Superseded in part 2026-09-26 (§10.10):* `retry_scheduled` → "Retrying" and the parked
> "next try at HH:MM" message are gone. Nothing re-sends a Tor payout now, so a legacy row reads
> "being checked", and `tor_held` has its own strip, tile and slow poll.

### 10.10 Tor payouts: one attempt, then an answer (2026-09-26, add-ons — NOT VPS-tested)

**Origin.** Mainnet payout #10 (2026-09-25) passed the pre-flight probe, then parked
`retry_scheduled` "wallet unreachable" with a next attempt 6 h away. The operator asked for a
Tor payout to end in an answer instead of a ladder. They decided the design on 2026-09-26:

- A Tor payout is **tried once**. It ends **Paid**, **Failed** with the balance returned at once,
  or **Held** when the pool genuinely cannot tell. A Held amount stays locked and is never sent
  again.
- The 6/12/24/48 h ladder, the 1 h shortfall retry and the 15 min tor-down retry are removed.
  **No automatic re-send of a payout exists, anywhere.**
- The step-by-step sender (§10.8 F5) is deleted.
- 5 counted failures in 24 h pause Tor for that address for 24 h.
- After any Tor "no", the page **offers** Slatepack. It never creates one by itself.

Built in four sessions the same day (delete stepwise → backend → front end → an independent
review), all in the `add-ons` working tree, **uncommitted and never run on a VPS**. The durable
design and the rejected alternative are in **design §8**. The operator tests on mainnet only, so
the acceptance run is a mainnet one.

#### Payout #10's cause — the binary was never found

The mainnet journal showed `Send failed for withdrawal 10: spawn grin-wallet ENOENT` on both
attempts. `lib/wallet-tor.js` spawned a bare `grin-wallet`, which is a `PATH` lookup. The toolkit
installs the binary only at `<wallet_dir>/grin-wallet` (`07_lib_pool_wallet.sh`), and the pool's
systemd unit sets no `PATH`. So the process never started and nothing was locked or sent. The
same bug broke `repostTx` (F2). It was the first Tor payout the mainnet pool ever made, so
grin-wallet's own Tor has **never** run there.

**Fix:** `this.walletBin = path.join(walletDir, 'grin-wallet')`, used by `execWalletCommand`.
This is also why the probe said ✓: the probe runs in Node through the system tor, while the send
is a separate `grin-wallet` process with its own Tor.

#### The one attempt (`lib/withdrawal-scheduler.js`)

The request path is unchanged up to the lock. The checks run in this order: ownership proof →
`precheckWithdrawable` → **Tor pause** → pre-flight probe → `createWithdrawal` (lock). The next
scheduler pass claims the row `tor_checking → tor_sending` with a guarded write and runs ONE
`grin-wallet send -d`. `_settleFailedTorSend` decides the outcome:

| | The send… | Result |
|---|---|---|
| A | printed `Tx sent successfully` | `confirmed`. F1/F2 then watch it mine. A delivered send resolves the `tor_send_path` alert. |
| B | fell back to a slatepack, its slate id was read from its own output, and `cancel_tx` of that slate succeeded | `tor_failed`, refunded now. Then one **fresh** onion probe names the code: `false` → `wallet_offline`, `true` → `pool_send_path` (+ the rolling `tor_send_path` warning), `null` or a throw → `wallet_unreachable`. |
| C | was refused for `NotEnoughFunds`, **and** the tx log shows no matching send | `tor_failed`, refunded now, `pool_busy`. A match or an unread log → Held. |
| D | anything else: a timeout kill, unrecognised output, a fallback with no id or a failed cancel, a throw after the claim | `tor_held` |

- **A row with any earlier attempt is never handed to the wallet again.** That means any
  `to_status='tor_sending'` event, `retry_count > 0` or a `slate_id`. Such a row goes straight to
  Held. This is what makes "no re-send" true by construction: no guard has to read the wallet
  right for it to hold.
- **The stale sweep** (`reclaimStaleTorSending`) confirms a stale `tor_sending` row whose send is
  confirmed and holds every other one. It no longer refunds on one read.
- **Removed:** `processRetryQueue`, `initiateWithdrawal`, `scheduleRetry`, `markFailed`,
  `_deferSend`, `_retryReasonFor`, `retryDelays`, the shortfall / tor-down constants, and the
  `payout.withdrawal_retry_delays` default and config key. A stored row of that key stays inert
  (admin-guards `[9]`).
- **Kept:** `_dropStepwiseSlate` (a row F5 touched may still carry its slate id), the
  `tor_step` / `tor_final_slate` columns (INERT, nothing writes them; see `lib/db.js`), and the
  admin strip of `tor_final_slate`.

#### Held, and how it resolves

`resolveHeldTor` runs every tick **before** the freeze branch, because it never sends. One
refreshed tx-log read serves every held row (rules as amended by *Review fixes* below):

- **confirmed** → `confirmed`, frozen or not.
- **absent or cancelled on two reads at least `HELD_ABSENT_GAP_S` (600 s) apart** → `tor_failed`,
  refunded, `unknown`. One read can race a wallet process that is still running. Both reads must
  be taken **while unfrozen and after the last resume**, from a log that still carries the row's
  **wallet history mark**; otherwise the outcome is `frozen` or `history_changed` and nothing moves.
- **unconfirmed** → stays held, and it resets an absent streak. The row's own never-finalized
  fallback lock (`Standard1`) is cancelled again; its own round-tripped send (`Standard2`, one
  attempt, one tx) is re-broadcast hourly while unfrozen.
- **unreadable** → stays held and decides nothing.
- Held longer than `HELD_ALERT_S` (24 h) → one rolling **critical** `payout_held` alert, with a
  runbook in its data.

The operator has two actions. **Re-check** (`POST /api/admin/withdrawals/:id/recheck`,
`secureAdmin`, audited) runs the same rules for one row, with no force. **Forced refund**
(`…/force-refund`) needs `freshAdmin`, the payout id typed back as `confirm_id`, and an audit
row. `forceRefundHeld` refuses when the log cannot be read or matched, when it shows the payout
confirmed, when a confirmed tx matches this payout and another one (the ambiguous case below), and
— since the review fixes — when an unconfirmed match is anything but a bare `Standard1` lock.
Neither action ever sends.

**The startup migration** (`migrateLegacyTorRetries`) runs once, at the top of `schedulerLoop`.
It settles every legacy `retry_scheduled` row from one read: confirmed → confirmed, absent →
refunded (`unknown`) — **held instead while payouts are frozen** — anything else → Held. One read is enough here: the row was parked after its
send returned, and no send has started in this process yet. It is idempotent because every branch
moves the row out of `retry_scheduled` with a guarded write. It relies on no orphan CLI outliving
a restart. The unit sets no `KillMode`, so the default `control-group` kills the CLI with the
backend.

#### How the pool knows whether a send landed (`_priorSendLanded`)

Every refund path depends on this matcher saying `absent` only when nothing was sent. The
Session 4 review re-derived it from grin-wallet **v5.5.0** (`ffcdf78`; grin core `d5f3235`):

- **`lock_tx_context` writes TxSent AT LOCK**, with `amount_debited` = Σ inputs,
  `amount_credited` = Σ change, `fee` and `creation_ts` = the lock time. So
  `debited − credited − fee` is exactly the recipient amount, and a posted send can never be
  missing from the log.
- **The fee field is `FeeFields` serialised as its RAW u64**, `(fee_shift << 40) | fee`. The pool
  subtracted the raw value. Upstream subtracts `.fee()`. `_txRecipientNano` now masks to 40 bits
  (`FEE_MOD`). v5.5.0 always writes shift 0, so this was latent at the pinned version.
- **The double-pay the review found and fixed (R1).** Take two Held rows with the same net and no
  slate id. The matcher had only a lower time bound plus a "claimed" set. Miner A's mined tx
  confirmed the lower-id row, which was miner B's, and B had never locked anything. A's tx then
  counted as claimed, so A's row read absent twice and was **refunded on top of a send that had
  landed**. This was reproduced against the real scheduler first.
- **The fix — attempt windows.** The amount branch accepts a tx only if it was locked inside one
  of the row's own attempts. `_torAttemptWindows` runs from each claim event to the event that
  moves the row out of `tor_sending`, ± `ATTEMPT_WINDOW_SLACK_S` (5 s). The window stays open
  while the row is still in flight. A row that was never claimed keeps the old bound.
- A tx held by a Slatepack or Goblin row is excluded, because that slate id is authoritative.
- A tx that another **Tor** row holds, or that fits another same-net Tor row's attempt
  (`_otherTorAttemptAt`, a crash overlap), is **ambiguous**. It settles neither row: the row is
  not confirmed, and it is not absent.

#### Tor pause

The limits are module constants, not settings: `TOR_FAIL_MAX` 5, `TOR_FAIL_WINDOW_S` and
`TOR_PAUSE_S` 86 400.

- **Only `wallet_offline` counts.** It is timed by the row's `tor_failed` **event**, not by when
  the payout was requested.
- `paused_until` is the 5th most recent counted failure + 24 h. By then the older counted rows are
  outside the window, so the pause ends cleanly.
- The withdraw route checks the pause after `precheckWithdrawable` and **before** the probe. A
  paused address gets 429 `{ error: 'tor_paused', paused_until, failures_24h, max,
  suggest: 'slatepack', message }`. Nothing is locked and no Tor circuit is built.
  `createWithdrawal` checks again, except for an admin override.
- `GET /api/account/:addr` carries `tor_pause: { failures_24h, max, paused_until }`, and the admin
  miner view shows it.
- `POST /api/admin/miners/:addr/tor-pause/clear` (`freshAdmin`, audited) re-codes the counted rows
  to `wallet_offline_cleared`. It deletes no history.
- **Cooldown:** `_assertNoRecentReversal` skips a reversal whose row is `method='tor'` and
  `status='tor_failed'`. A Tor refund now needs proof, and proof is what the 30 min cooldown was
  standing in for. The cooldown still applies after a Slatepack expiry, a Goblin failure or an
  admin cancel.

#### `fail_code`, `fail_detail` and where `tor_held` is listed

- **`withdrawals.fail_code`** is public-safe: `wallet_offline` | `wallet_unreachable` |
  `pool_send_path` | `pool_busy` | `unknown` | `wallet_offline_cleared`. It is on P-08 and in the
  account summary.
- **`withdrawals.fail_detail`** holds the CLI error or output tail, ≤ 500 chars. It is
  **admin-only**. `test-public-leakage.js` asserts that no public route and not the account page
  ever names it. An unrecognised exit-0 error carries a 300-char stdout tail.
- `_reverseLock` writes `fail_code`, `fail_detail`, `triggered_by` and `actor_id` in the same
  transaction as the claim and the balance move.
- **`tor_held` is in every pending list:** `PENDING_SQL`, the three `index.js` lists,
  reconciliation's pending sum **and** its `auditWalletSends` candidates, and AlertMonitor's
  `inFlight`. `getStatus()` gains `held_count`. `canInitiateWithdrawal` is unused and was left
  alone.
- **`payout_failed`** (AlertMonitor) now counts only the pool-side codes: `pool_send_path`,
  `pool_busy` and `unknown`. With one attempt, every offline miner produces a `tor_failed` row.
- **The admin retry route answers 410** with a reason (`secureAdmin`), so a stale page says why.
- **Admin cancel** refuses `tor_held` and legacy `retry_scheduled`. Before this change, both were
  refunded with no wallet check.

#### Front end

**Account page** (`account-settings.html`):

- **The offer.** The Tor pane has one offer block, `#acct-sp-offer`: a terms line, *Send as
  Slatepack instead* and *Check again*. The pure `slatepackOfferMode(summary, torNo)` decides it:
  `paused` comes from the summary, and otherwise the last Tor "no" on this page — the pre-flight
  409 or a failed outcome.
- **When the offer hides:** while any payout is pending (Held too), when payouts are frozen,
  below the minimum, and for `pool_busy`.
- **The click** checks the Slatepack radio and calls the **existing** `slatepackCreate()`. There
  is no second create function, and `slatepackCreate` gained an in-flight guard, `spCreating`. The
  terms line takes N from `slatepack_window_minutes` and invents no number when it is null.
- **The pause line.** `#acct-tor-pause` shows the UTC end time and disables *Pay to Tor wallet*.
  Below the pause it reads "Failed Tor payouts in the last 24 h: N of 5". A 429 `tor_paused`
  re-reads the summary.
- **Outcomes** are keyed on `fail_code` (`TOR_FAIL_OUTCOME`). `pool_busy`, an unknown code or a
  null code gets no offer.
- **P-08** gets short reasons through a new `payout-methods.js` registry hook, `rowLabel`.
- **Held** has a strip, a tile, and a 60 s poll for 30 min (`PENDING_SLOW`). That covers the
  two-read refund with margin. After 30 min it is an operator case, and a reload restarts the
  watch.
- **Legacy `retry_scheduled`** reads "being checked", with no "next attempt" time.
- The homepage P-08 line no longer promises "retried automatically (6h → 48h)".

**Admin:**

- `payments.html`: a Held badge and filter chip, and "Failed (refunded)". The Retry button is
  gone. Cancel is shown only for `tor_checking` (`tor_failed` too until 2026-09-27; see *Admin
  cancel on `tor_failed`* below). Held rows get 🔎 Re-check and
  ↩ forced refund: one native `prompt` for the typed id, checked client-side first. There is no
  chained dialog, because a suppressed second dialog reads as cancel.
- The "Retries" column became "Reason" (`fail_code` + escaped `fail_detail`), and the queue
  summary shows `held_count`.
- `index.html` has a Held badge. `miners.html` gets a 🧅 miner-view card with the pause state
  and *Clear Tor pause*.
- **The two new alerts show on the health page's Grin Wallet card** since the follow-up fixes
  below (`AlertMonitor.foldPayoutAlerts`). Before that they lived in the `alerts` table only.
  There is still no admin alert list, and no alert type is pushed off-box (§J8-3).

#### Markers the code keys on (these replace §10.8's retry markers)

| Kind | Value | Written by | Read by |
|---|---|---|---|
| event-note prefix | `held:` | `_holdTor` | operator log only. The streak reset keys on the **event** into `tor_held`, not on this prefix |
| event-note prefix | `held-check: absent` | the first absent read of a streak | `_heldAbsentSince`: its `created_at` starts the 600 s clock |
| event-note prefix | `held-check: unconfirmed` | an unconfirmed read that ends a streak | `_heldAbsentSince` |
| event-note prefix | `tor-pause:` | `clearTorPause` | operator only |
| event-note prefix | `repost:` | F2 CLI repost (unchanged) | once per hour, 24-cap |
| event-note prefix | `slate: <uuid> created (stepwise)` | the deleted F5 sender | `_dropStepwiseSlate` |
| `alerts.type` | `payout_held` (critical) | `_raiseHeldAlert` | health, Grin Wallet card (Critical) |
| `alerts.type` | `tor_send_path` (warning) | outcome B with probe `true` | health, Grin Wallet card (Degraded); resolved by the next delivered Tor send |
| `alerts.type` | `pool_wallet_short`, `payout_unmined` | unchanged | health, Grin Wallet card |

Renaming a `held-check:` prefix silently changes **when a refund happens**. Grep before touching
one. `shortfall:`, `tor-down:`, `deferred:` and `stepwise:` are no longer written. Old rows still
carry them.

#### Tests

`npm test` was re-run for this section on 2026-09-26: exit 0, 21 suites, 1900 checks. The five
touched suites stand at, per session:

| Suite | Before S1 | S1 | S2 | S3 | S4 (now) |
|---|---|---|---|---|---|
| `test-payout-guard.js` | 256 | 186 | 268 | 268 | **277** |
| `test-payout-rails.js` | 122 | 106 | 106 | 150 | **150** |
| `test-admin-guards.js` | 128 | 118 | 123 | 123 | **123** |
| `test-admin-panel.js` | 105 | 104 | 104 | 120 | **120** |
| `test-public-leakage.js` | 116 | 116 | 121 | 124 | **124** |

Only the last column was checked here. The earlier columns, and these claims, come from the build
and review sessions' own reports and were **not re-checked**:

- every new check failed on the code before it;
- the mutation passes caught every revert (Session 2: 38; Session 3: 12/12; Session 4: 27/27, one
  of them an equivalent mutant);
- the headless probe covered 10 states × 2 themes × 390 / 1280 px.

`[routes]` evaluates the **real** `index.js` handlers in-process, with stubs. RT1 proves the probe
is not called while paused. RT9 drives two concurrent Slatepack POSTs through the real
`/withdraw` handler and gets one row, one 200 and one 429.

#### Follow-up fixes (2026-09-26, operator-approved after Session 5)

The operator approved the recommended fixes from the open-decisions list. Each got a test written
first and seen failing on the code before the fix, with its controls passing. `npm test` afterwards:
exit 0, 21 suites, **1932** checks. payout-guard 277 → **290**, admin-guards 123 → **136**,
rate-limits 51 → **57**; every other suite unchanged.

- **The two payout alerts are on the health page.** `payout_held` (critical) and `tor_send_path`
  (warning) now fold into the Grin Wallet card beside `payout_unmined`. The fold is one helper,
  `AlertMonitor.foldPayoutAlerts(db, card)`, and the health route calls it instead of its old
  inline `payout_unmined` query. A critical alert outranks a degraded card and never masks
  `error`. `health.html` needed no change; it already escapes the message and draws a Critical
  badge. Tests: `[health-card]` HC0–HC6.
- **The unrecorded-send audit no longer treats a refunded Tor row as a recorded payout.**
  `auditWalletSends` dropped `tor_failed` from its candidate rows. A Tor row is failed only on
  proof that nothing was sent. So a confirmed send whose only match is such a row is a double
  pay: a critical `unrecorded_wallet_send` alert and the auto-freeze, as intended. A confirmed row
  and a Held row still match. Test: `[health-card]` HC7 + 2 controls.
- **`_captureTorSlateId` uses the attempt windows.** A tx counts only inside the row's own attempt
  (the old bound was `created_at − 60 s`, open-ended). A tx that also fits another Tor row's
  attempt is not captured. A wrong capture could no longer refund anything, but it put another
  payout's kernel link on this one. Tests: `[review-s4]` CT1 (+ control), CT2.
- **`max_pending_withdrawals` / `max_user_pending` are validated.** Whole numbers only, 1–10 000
  and 1–100, parsed with `Number()` so `'12abc'` is refused. Values are stored as numbers, so the
  first save of the form's text defaults no longer names both keys as changed. The two inputs
  gained matching `min` / `max` / `step`. Tests: admin-guards `[10]`.
- **The withdraw POST has its own nginx read timeout, 90 s.** It is a regex block,
  `location ~ ^/api/account/[^/]+/withdraw$`, in `07_grin_mining_public_pool.sh`. It has the same
  zone, upstream and client-IP headers as `/api/`, and no `add_header`. Every other `/api/` read
  keeps 30 s. The pre-flight probe's ~32 s worst case no longer 504s the miner. It reaches a box
  only through a **Setup nginx** re-run. The heredoc was rendered with dummy values and the regex
  came out with a literal `$`. Tests: rate-limits `[9]`.
- **`socks` removed** from `package.json` and the lockfile (`npm uninstall`, then only the one
  line kept in `package.json` so npm's re-sort is not in the diff). `smart-buffer` went with it,
  and `ip-address` stays, now marked optional under `geoip-lite`. `npm ci --dry-run` is in sync.
  The deploy gate hashes both files, so the next deploy reinstalls.

**Not done — blocked (Session 4 finding (a)).** Binding a crash-overlap match by the tx's
`payment_proof.receiver_address` was tested first: seven new tests failed on the old code as
expected. But the edit that adds the key helper to the scheduler was **refused by the
session's permission classifier**, and no reason was given. The partial edits were reverted, so
the matcher is exactly as Session 4 left it. The source facts behind the design were re-checked
this time against grin-wallet **v5.5.0** (`libwallet/src/types.rs` `StoredProofInfo`,
`slate_versions/ser.rs` `dalek_pubkey_serde` = lowercase hex of the 32 key bytes,
`internal/selection.rs` `lock_tx_context` writing `payment_proof` from the slate at lock). The
pool's `send -d` never passes `--no_payment_proof`. Building it needs the operator to allow that
edit.

#### Pre-test review fix: the grin-wallet command line (2026-09-26)

A review before the mainnet test found that **no Tor payout could ever have been sent**. The pool
ran `grin-wallet --top-level-dir <dir> send -d <addr> -a <amount>`. grin-wallet v5.5.0 declares
its CLI in `src/bin/grin-wallet.yml` and parses it with clap **2.34**, which matches long flags
exactly. Both halves were wrong there:

- The top-level flag is `top_level_dir`, with underscores. Every toolkit shell caller already
  spells it that way; only `lib/wallet-tor.js` used hyphens.
- `amount` is `send`'s **positional** argument (`index: 1`). `-a` is the top-level `account`
  flag, which nothing marks `global`, so clap refuses it after `send`.

Either is a clap error and exit 1 before anything is built. Under the one-attempt rules that is
outcome D: Held, then refunded as `unknown` after two absent reads. It was safe, but the payout
could never go out. `repost` (the unmined watchdog) had the same wrong top-level flag.

This had been the argv since the pool moved into the toolkit (`f0eea42`, 2026-06-06). Every test
stubbed `execWalletCommand`, so none saw the command line. Mainnet payout #10 died on
`spawn … ENOENT` first, so clap never got the chance to refuse it.

**Fixed:** `send` is now `--top_level_dir <dir> send -d <addr> <amount>`, and `repost` is
`--top_level_dir <dir> repost -i <id> -f`.

**Test:** `test-payout-rails.js`, *the grin-wallet argv is valid for v5.5.0*. It carries the
v5.5.0 flag spec as data and parses the pool's argv the way clap 2 does. Two controls check that
the old argv is refused. The 8 argv checks failed on the old code and pass now. payout-rails
150 → **160**; `npm test` exit 0, 21 suites, **1942** checks.

Read in the v5.5.0 source in the same review, with no change needed:

- the `Tx sent successfully` line, and `output_slatepack` printing
  `<tld>/slatepack/<id>.S1.slatepack` before `Slatepack data follows` (what `classifySendOutput`
  keys on);
- on success, the lock happening only after the Tor round-trip;
- the sender tor killing a stale pidfile process on its next launch;
- `send_config_dir` coming from the wallet's toml;
- `skip_send_attempt` defaulting to false.

#### Review fixes (2026-09-27, from the /review of 2026-09-26)

An independent review of the whole payout path (read-only; five findings reproduced with a scratch
harness against the real scheduler) found no way for a normal failed payment to be sent or refunded
twice, but six issues. The operator asked for all six to be fixed. Every non-control check below
was seen failing on the code before its fix. Each grin-wallet fact was read in the v5.5.0 source.

1. **Held refunds wait for a resume and an intact wallet history** (`resolveHeldTor`,
   `_heldAbsentSince`, `migrateLegacyTorRetries`). Restore, Migrate IN, the wallet-switch wizard and
   an identity mismatch all FREEZE payouts, but the Held check refunded while frozen. It judges
   "absent" by reading whatever wallet answers the Owner API, and a seed recovery, an older wallet
   backup or a different wallet reads "absent" for a send that landed: a double pay. Now:
   - while frozen, an absent read is neither journaled nor acted on (outcome `frozen`); confirmations
     still settle, and the legacy migration holds an absent row instead of refunding it;
   - a streak counts only reads taken after the last resume (`payout_control.updated_at`,
     `_lastResumeAt`);
   - the first unfrozen check records the newest tx-log entry as the row's **history mark**
     (`held-check: wallet mark {"id":…,"ts":"…"}`; id and creation time are the two fields
     grin-wallet never rewrites). A log that no longer carries that exact entry proves nothing:
     outcome `history_changed`, the row stays Held, one console error per row. The forced refund
     stays the operator's override on a changed history, and reports `wallet_history`.
   The mark is taken at the first Held check, not before the send, so a first attempt still makes
   no wallet call before the send (§J4-2). Tests: `[review-fixes]` F1a–F1e, and H9 now asserts the
   new rule.
2. **The Tor CLI send holds the wallet send lock for its whole run** (`sendWithdrawal`,
   `_assertNoTorSend`). `grin-wallet send` selects its coins at start and locks them only after the
   Tor round trip; selection takes the smallest coins first and `lock_output` never checks an
   existing lock. So a Slatepack or Goblin create during a Tor send picked the same coins, and the
   chain could accept only one of the two transactions. No money was lost, but the losing payout
   stuck: `finalizing` forever, or Held. The CLI is this process's own child, so this process's
   `withSendLock` covers it. While it runs, both creates refuse at once with a 503 ("the pool wallet
   is sending another payout right now — nothing was deducted"), BEFORE the balance lock, so no
   reversal and no cooldown. A freeze that lands while the Tor send waits for the lock stops it
   before the claim. Tests: F2a–F2c.
3. **The CLI's own output reaches the settlement** (`execWalletCommand`, `sendToTorAddress`).
   grin-wallet prints every error on **stdout** (`println!("Wallet command failed: {}")`, exit 1),
   and log4rs writes there too. Only clap usage errors use stderr, yet the pool kept stderr alone.
   So outcome C (NotEnoughFunds → `pool_busy`, refund now) could never match, and `fail_detail`
   read `Command failed (code 1): ` for every failure. A 300-char tail of stderr + stdout is kept
   now, on a non-zero exit and on a timeout. A CLI that printed `Tx sent successfully` or its
   slatepack fallback and then hung until the timeout is settled by what it printed, not as an
   unknown. Tests: payout-rails n–p, F3 (the real `execWalletCommand` with a `node -e` child).
4. **The forced refund reads `tx_slate_state`** (`forceRefundHeld`, `resolveHeldTor`). v5.5.0
   records the state of the slate a TxSent was LOCKED with, and nothing on the send side updates it
   (only `receive` and `process_invoice` call `update_tx_slate_state`). So `Standard1` is the CLI's
   slatepack fallback, a bare lock that nothing finalizes. `Standard2` got past the Tor round trip
   and may have been finalized and posted. Now:
   - the forced refund refuses an unconfirmed match that is not `Standard1`, including one with no
     recorded state, and tells the operator how to void it;
   - on its own fallback slate it cancels that slate first (503 if the cancel fails); a lock found
     only by amount is never cancelled;
   - the Held check re-cancels a row's own `Standard1` fallback slate, because the send-time cancel
     needs a live node and could fail;
   - the Held check re-broadcasts a row's own `Standard2` send hourly (the F2 limits, never while
     frozen), and only for a row with exactly one attempt and one matching tx. A legacy row with
     two attempts could own two finalized txs, and landing one of them could complete a double pay.
   Tests: F4a–F4h; H11 now uses a `Standard1` match.
5. **The unrecorded-send audit compares the NET that left** (`auditWalletSends`). It compared the
   GROSS row amount to the wallet's net at ±0.05 GRIN, which worked only while `withdrawal_fee` was
   under 0.05. At 0.1, every Tor payout without a captured slate read as an out-of-band send: a
   critical alert and an auto-freeze. It now compares `amount − fee_charged` within 1 µGRIN. A
   MANUAL row (`dormancy.js manualPayout`, typed by the operator) keeps ±0.05. Tests: F5.
6. **The send timeout default is 360 s** (`WalletTor.DEFAULT_SEND_TIMEOUT_MS`, which the
   stale-send sweep also reads, so its window is 840 s). v5.5.0 waits up to 60 s at each of six
   steps of a send: the node version check, the wallet refresh, the Tor bootstrap, `check_version`,
   `receive_tx` and `post_tx`. A kill is the one outcome the pool can only Hold. An explicit
   `wallet_send_timeout_ms` still wins. Tests: payout-rails q, F6.

Admin page: the Re-check message names the four new outcomes, and the forced-refund message says
when it cancelled a fallback slate first or the wallet history had changed. The force-refund
audit row records `wallet_history` and `cancelled_slate`. `npm test` exit 0; payout-guard
290 → 328, payout-rails 160 → 170.

#### Slatepack finalize binding (2026-09-27, found after the review fixes)

Found by a short look from a cheating miner's side, the question the /review above did not ask.
Security audit roll-up note *Slatepack finalize binding*. Uncommitted, NOT VPS-tested.

- **The hole.** `finalizeSlatepackWithdrawal` and `finalizeNostrWithdrawal` compared the reply's
  slate id with the row's only `if (w.slate_id && …)`. A new row is committed as
  `slatepack_pending` with no `slate_id`, and the id is attached only after three wallet calls.
  The finalize route takes the withdrawal id from the URL, and the Goblin bridge routes a DM to the
  sender npub's oldest pending row, so a reply can reach the row inside that window. A reply that
  decoded to no id skipped the compare too. Either way it went to `finalize_tx`, whichever slate it
  belonged to.
- **Why that pays twice.** grin-wallet v5.5.0 finalizes any slate whose private context it still
  holds while the entry is `TxSent`: `cancel_tx_and_outputs` keeps the context, and only
  `update_stored_tx`'s `TxSent` match refuses a cancelled slate. Expiry refunds first and cancels
  second, and `cancel_tx` needs a node. So the reply to an expired 1000 GRIN Slatepack, refunded
  while its cancel was still owed, posted through a new 25 GRIN row: 1000 left the wallet and the
  ledger recorded 25. The harness reproduced exactly that against the real scheduler.
- **The fix: both paths fail closed.** A row with no `slate_id` refuses any reply before the claim:
  a 409 on the manual rail, and the reply is ignored on Goblin. The create then attaches as normal.
  A reply that decodes to no id is refused like a mismatch, and the claim is released. An honest
  miner cannot hit either check, because both creates attach the id before they return or publish
  the S1.
- **Tests:** `test-payout-guard.js` `[binding]` B1–B4 drive the attack through the real create
  window on both rails, plus the id-less reply. All 8 B checks failed on the old code, where the
  old slate was finalized and posted through the new row and that row confirmed as paid. The
  setup check and the C1/C2 controls passed on both versions. Payout-guard 328 → 340; `npm test`
  exit 0.
- **Not exposed: the Tor rail.** It refunds only once the wallet shows the send cancelled or never
  locked, and grin-wallet will not finalize a cancelled slate.

#### Admin cancel on `tor_failed`, and the rail on every payout label (2026-09-27, operator request)

Uncommitted, NOT VPS-tested. The operator saw a Cancel button on a failed Tor payout whose amount
the account page already showed as "payout returned".

- **Cancel on `tor_failed` is gone, from the page and the route.** The row was refunded when it
  failed, so the route moved no money. It only relabelled the row `cancelled`, and four readers key
  on `tor_failed`. `auditWalletSends` counts `cancelled` as recorded, which hides a double pay (the
  hole the *Follow-up fixes* exclusion closed). The Tor pause stopped counting a `wallet_offline`
  failure, which *Clear Tor pause* already does with its own event and audit row. The pool-side
  `payout_failed` alert lost the row. `_assertNoRecentReversal` began counting the old refund, so
  the miner's cooldown restarted. `POST /api/admin/withdrawals/:id/cancel` now answers 409
  "already refunded". `payments.html` offers Cancel only on `tor_checking`. This was the pre-test
  review item and the /review's Low #8.
- **The rail on every payout label.** `GET /api/account/:addr/balance/log` returns
  `payout_method` on withdrawal rows (`tor` · `slatepack` · `nostr` · `manual`, null otherwise).
  It is a subquery on `withdrawals`, bound by id and address, not a JOIN, because the `where`
  clause and `LEDGER_DIRECTION_SQL` name `grin_address` / `created_at` unqualified. The CSV is
  unchanged. P-06/P-07 read "payout requested · Tor" / "payout returned · Slatepack", worded by
  `PayoutMethods.methodLabel`. Nothing new is public, because P-08's `GET …/withdrawals` already
  returns the method. In `payments.html` the `STATUS` labels lost their rail ("Failed (Tor)" →
  "Failed"), and the badge appends it from `w.method` for every row: "Paid · Tor",
  "Failed · Slatepack", "Awaiting slate · Goblin".
- **Tests:** `test-payout-guard.js` RT6 (admin cancel refuses `tor_failed`, 409, status and
  `fail_code` kept) and RT5b (ledger rows carry `payout_method` through the real handler and the
  real direction SQL, lifted from `index.js`; null on a block row that shares the id and on another
  address's payout). Both non-control checks failed on the committed `index.js`. Payout-guard
  340 → 344. `test-admin-panel.js` [11]: Cancel is pinned to `tor_checking` alone, plus the rail
  badge. `npm test` all pass.

#### Still open

- **VPS acceptance, on mainnet.** Nothing here has run on a box. The run covers: a paid payout;
  a listener down after the gate (`wallet_offline`, Slatepack at once, "1 of 5"); five failures
  → pause, and an admin clear; a broken pool-side Tor (`pool_send_path`, the alert); a backend
  killed mid-send → Held → resolves on its own; a legacy `retry_scheduled` row migrated at first
  start; the freeze; and the Slatepack offer after each kind of "no". Since the review fixes also:
  a Slatepack create during a Tor send is refused with nothing deducted; a Held payout is not
  refunded while frozen; and a CLI failure shows grin-wallet's own message in the Reason column.
  Since the binding fix: a normal Slatepack payout still finalizes with its own reply.
- **Residual of review fix #1:** the history mark is taken at the first Held check, so a restore
  between a crash mid-send and that check is not caught. The restore's own freeze gives the
  operator the window to reconcile. More generally, a restore to a point BEFORE a send is invisible
  to the pool, because it holds no record of the send. Reconcile against the chain before resuming.
- **An ambiguous pair has no operator exit (Session 4 finding (a), PLAUSIBLE, not fixed).** It
  needs a crash mid-send, the same net and a confirmed tx inside both rows' windows. The row stays
  Held, the forced refund refuses, and there is no forced confirm. The proposed fix binds a match
  by the tx's `payment_proof.receiver_address`. grin-wallet writes that AT LOCK as lowercase hex of
  the 32-byte ed25519 key (`types.rs` `StoredProofInfo`, `ser.rs` `dalek_pubkey_serde`,
  `selection.rs`). It would be matched **positively only**, so a decode bug degrades to "hold" and
  never to "absent". **Approved by the operator 2026-09-26, but the build was BLOCKED** (see
  *Follow-up fixes*). Until it is built, the `payout_held` runbook tells the operator to read the
  proof by hand.
- **Accepted by the operator 2026-09-26 (PLAUSIBLE, not fixed):**
  - The forced-refund and Re-check audit rows are written after the money move, outside its
    transaction.
  - An IP-proof co-tenant (§J3) can spend the owner's 5 counted failures, but only while the
    owner's wallet really is offline.
  - No paused badge on the admin miners **list** (it needs a per-row pause query).
- **Deferred:** a `fail_code` column in the CSV export (operator's choice), and off-box alert
  delivery (§J8-3, its own project).
- **Found while fixing the audit, not fixed:** `auditWalletSends`'s `feeNano` subtracts the RAW
  `FeeFields` u64, the same latent bug R1d fixed in the scheduler. v5.5.0 always writes shift 0,
  so it cannot bite at the pinned version.
- An ACTIVE `payout_tor_stepwise` alert row, if one exists, is resolved by nothing now. Mainnet
  never ran stepwise, so none should exist.
- **Found in the pre-test review, not fixed (awaiting the operator):**
  - (The send timeout item was fixed by *Review fixes* #6: 360 s.)
  - (Admin cancel on a `tor_failed` row was fixed 2026-09-27: see *Admin cancel on `tor_failed`,
    and the rail on every payout label* above.)
- **Found in the /review of 2026-09-26, Low, not fixed:** admin cancel of a `tor_checking` row does
  not check for an earlier send attempt, so a legacy row the old Retry button re-queued is refunded
  with no wallet check. It is reachable only while frozen (right after a restore or Migrate IN),
  and the route's final UPDATE is not status-guarded. `recordTorFee` matches by amount with no
  attempt window. The create paths parse the amount with `isNaN`, although the balance CAS already
  refuses `Infinity`.
  - `spawn … ENOENT` is proof that nothing was sent, but it is handled as outcome D (Held, then
    a refund after ≥ 10 min).
  - `execWalletCommand` has no `error` handler on the child's stdin. An EPIPE from a CLI that
    exits before reading the passphrase would be an uncaught error. The stale sweep would then
    hold the row, so money stays safe.
  - The send inherits the service's `HOME` and working directory. The listener runs with
    `HOME=<wallet dir>`. v5.5.0 falls back to `$HOME` only for a node-secret file missing at
    config generation, so an existing wallet is not affected.

### 10.11 Slatepack expiry gate + pool wallet safety notes (2026-09-27, add-ons — NOT VPS-tested)

**The question that started it (operator, 2026-09-27).** On a slatepack payout, the miner's
`grin-wallet receive` first tries to send its reply back over Tor, and only prints a slatepack to
paste when that fails. If the Tor reply ever worked, would the pool see the payout, or refund it
and pay twice?

**What grin-wallet v5.5.0 does** (read in the source at tag `v5.5.0`, `ffcdf78`):
- `receive` (`controller/src/command.rs`) takes the sender address from the slatepack and, unless
  given `-m`/`--manual`, calls `try_slatepack_sync_workflow(…, send_to_finalize = true)`
  (`api/src/owner.rs`). `TorSlateSender::send_tx` (`impls/src/adapters/tor.rs`) then POSTs
  `finalize_tx` to `<sender onion>/v2/foreign`.
- The Foreign RPC `finalize_tx` (`api/src/foreign_rpc.rs`) hard-codes `post_automatically = true`.
  So the pool wallet would finalize **and post** a payout without the backend knowing.
- Our S1 always carries that address: `createSlatepackMessage` sends `sender_index: 0`, so the
  miner's reply is encrypted back to the pool.
- **It cannot happen as shipped.** Only `listen` (`controller.rs` `foreign_listener`, external tor
  or built-in Arti) publishes an onion. `owner_listener` never does, and the pool runs `owner_api`
  only (`07_lib_pool_wallet.sh`). The miner's Tor attempt always fails, and they paste the reply.
- **The tx log tells the two cases apart.** `lock_tx_context` (`libwallet/src/internal/selection.rs`)
  writes the pool's `TxSent` entry with the slate's state, `Standard1`. `finalize_tx`
  (`libwallet/src/api_impl/foreign.rs`) is one function behind both the Owner and Foreign APIs. It
  rewrites the state to `Standard3` via `update_tx_slate_state`, deletes the private context, and
  only then posts.

**The hole.** `processSlatepackExpiry` refunded every expired `slatepack_pending` row without
reading the wallet. If a slate was finalized outside the backend (an onion on the pool wallet, or
an operator's hand `grin-wallet finalize`), the row stayed pending and was refunded at TTL: paid on
chain AND refunded. The expiry `cancel_tx` succeeds on an unconfirmed `TxSent` even after it was
posted, so the flag cleared and `slate_refunded_but_mined` never fired. The Drop (059) avoided the
same Tor reply by emitting `sender_index: null` (`web/059_drop/server/app.js`). The pool keeps `0`
so the reply stays encrypted.

**The gate** (`lib/withdrawal-scheduler.js` `processSlatepackExpiry` → `_expiryVerdict`). One
`getTransactions(true)` read per batch; only the `TxSent*` entry for the row's `slate_id` counts:

| Wallet tx log for the row's slate | Decision |
|---|---|
| none, or `TxSentCancelled` | refund. **While frozen: wait**, because after a restore or wallet switch an absent slate proves nothing |
| `TxSent`, `confirmed` | **settle as paid** (`_creditConfirm` from `slatepack_pending`), never refund |
| `TxSent`, `Standard1` | refund: locked, never finalized (the normal "miner never replied") |
| `TxSent`, any later state | **hold**: stays `slatepack_pending`, re-read each tick, settles itself once mined |
| `TxSent`, state `null` / `Unknown` | refund + warning: the build does not record the state (**operator decision 2026-09-27, option (a)**: keep payouts flowing) |
| tx log unreadable | wait: never refund blind |
| row has no `slate_id` | refund, no wallet needed |

- **A held row still accepts the miner's own reply.** Re-finalizing a slate spends the same
  inputs, so at most one transaction can mine. The only double pay is refund + chain.
- **Batch:** the old `LIMIT 10` became `max(50, MAX_PENDING_WITHDRAWALS)`. Held rows are
  re-selected every tick and would otherwise starve newer expiries (the trap
  `reclaimStaleFinalizing` already documents).
- **Journal:** one `expiry-gate: held …` event per held row. The next tick keys on that prefix,
  so grep before renaming it. A settled row's confirm event starts `settled at expiry:`.
- **Alerts, both folded into the Health page's Grin Wallet card** (`AlertMonitor.foldPayoutAlerts`):
  - `slate_finalized_elsewhere`: **critical** while a row is held, resolved the tick nothing is.
    **Warning** for a day after a row was settled as paid. Either way, something can finalize
    pool slates outside the backend.
  - `slate_expiry_unverified`: warning for a day after a refund the gate could not check.
  - `_resolveQuietAlert` resolves a critical at once and a warning after 24 h of quiet.

**Where operators are told (all three built):**
1. **Admin → Payout settings**, first card: *Pool wallet safety* (`#pool-wallet-safety`, rail
   chip "Wallet safety"). It covers never letting the pool wallet listen on Tor, what the pool does
   if it happens anyway, and the tested grin-wallet version plus the three behaviours to re-check
   before a new one. It holds no inputs, so the save harvester never sees it. The Slatepack
   Response Window helper no longer promises "never a double-pay" unconditionally.
2. **Admin → Health, Grin Wallet card**: `grin-wallet: v5.5.0 (tested)`. NEW
   `lib/grin-wallet-version.js` runs `<wallet_dir>/grin-wallet --version` (cached 10 min, so a
   hub-05 rollback shows without a restart). Any other version → Degraded, never worse. Unreadable
   → reported, status unchanged. Wired in the `index.js` health route after the payout-alert fold.
3. **Toolkit**: `_pw_tor_exposure_check` in `scripts/lib/07_lib_pool_wallet.sh`, run after
   `pw_listener_start` unlocks and after the `pw_listener_status` line. It warns on a torrc /
   `torrc.d` `HiddenServicePort` aimed at `PW_OWNER_PORT`, or a `grin-wallet … listen` process on
   the pool wallet dir (cmdline `--top_level_dir` or cwd). Read-only, always returns 0.

**The tested version has three copies, pinned together by a test:** `TESTED_VERSION` in
`lib/grin-wallet-version.js`, `[data-tested-grin-wallet]` in `settings-payout.html`, and the
toolkit pin `GWI_DEFAULT_TAG` in `scripts/lib/grin_wallet_install.sh`. W5/W6 fail if one moves
alone. **Bump them only after re-reading, in the new release's source:**
1. `owner_listener` publishes no onion.
2. `lock_tx_context` / `finalize_tx` still write `Standard1` / `Standard3`.
3. The Foreign `finalize_tx` still posts.

**Tests** (`scripts/test-payout-guard.js` +33 checks; the file stands at 377, which also counts 4 `[routes]` checks added the same day by the concurrent *Admin cancel on `tor_failed`* change):
- **NEW `[expiry-gate]` G1–G12 (25 checks).** Run against the pre-gate scheduler, 16 failed and the
  section crashed. G4 is the double pay itself: the old sweep refunded a mined payout.
- **NEW `[wallet-version]` W1–W6 (8 checks).**
- **Fixtures updated to the v5.5.0 log shape:** the 31-min expiry case got a tx-log reader, the
  `[sp-recover]` fake wallet writes `Standard1` at lock, and `[health-card]`'s wipe clears the two
  new alert types.
- **Other suites, unchanged and passing:** `test-payout-rails.js` 170, `test-admin-guards.js` 136,
  `test-public-leakage.js` 124, `test-rate-limits.js` 58.

#### Follow-ups built the same day (operator request)

**The miner hint.** The account page's Slatepack pane (`account-settings.html`, P-04) now tells a
command-line miner to run `grin-wallet receive -m`. `-m`/`--manual` sets `skip_tor` (v5.5.0
`src/cmd/wallet_args.rs`, `grin-wallet.yml` `receive`), so the wallet prints the reply at once
instead of first timing out on a Tor reply that cannot reach the pool. It also removes the only path
by which a reply could ever arrive over Tor, if the pool wallet ever did get an onion.

**The "paid twice?" alarm on the Health card.** `slate_refunded_but_mined` (raised by
`retryExpiredSlateCancels` when a refunded slate is confirmed on chain) had lived only in the
alerts table, where no admin page showed it. It is raised once per payout and resolved by nothing
automatic, so folding it in as-is would pin the card red forever. So:
- **`AlertMonitor.foldPayoutAlerts`** folds it as **critical** and puts its id in
  `card.manual_alerts`. Past one occurrence it says how many, because a rolling alert keeps only
  the latest message.
- **`AlertMonitor.MANUAL_RESOLVE_TYPES`** lists `['slate_refunded_but_mined']`: the alerts an
  operator closes by hand. Keep it short, because every entry is an alarm a click can silence.
  **`AlertMonitor.resolveManual(db, id, actor)`** closes only those types. It returns 409 for any
  other type (the raising code resolves those itself), 409 for one already resolved, and 404 for
  an unknown id. It records `acknowledged_by`.
- **NEW `POST /api/admin/alerts/:alertId/resolve`** (`index.js`, **`freshAdmin`**) requires a
  non-empty `note` and writes an `alert_resolve` row to `admin_audit_log` (type, message, note).
- **`health.html`** loads `stepup.js` and shows **Mark reconciled** on the card while the alarm is
  active. One native `prompt` asks for the note, then the in-page step-up runs. The result shows
  in an inline `#health-msg` line, never `window.alert()`.

**Tests:** `[double-pay-card]` D1–D9 (14 checks) in `test-payout-guard.js` (now 391). Against the
committed `alert-monitor.js`, D1 and D2 fail and the section crashes. `npm test` exit 0, 2055
PASS/ok lines.

**Still open:**
- A held row that never mines (finalized but never posted, or dropped from the mempool) stays held,
  with its amount locked, until an operator acts. There is no forced refund for slatepack rows, and
  no automatic repost.

### 10.12 Admin Miners page — live status + per-rig rows (2026-09-27, add-ons — NOT VPS-tested)

`admin-panel/miners.html` was a flat balance list with an Online badge column, a lifetime-looking
Shares count and a separate 🧅 card for Tor state. It is now a miner console:

- **Status dot in the Miner cell** (Online column removed). Five states, computed on the SERVER
  in NEW `lib/miner-status.js` so the list and the expanded row cannot disagree:
  `mining` (≥1 live rig, none stalled or missing) · `degraded` (a live rig with no accepted share
  in `stall_s`, or a rig that shared inside `seen_s` has no session) · `connecting` (a session
  with no accepted share yet) · `offline` · and `banned`, drawn on top from the account flag.
  Rigs come from MINING sessions only (`acceptedShares > 0`, the §J6-9 rule), because stratum
  login is unauthenticated: a bare session never turns a dot green or names a rig.
- **Windows** `{ hashrate_s: 600, seen_s: 3600, stall_s: 900 }` live in `WINDOWS` in that lib
  only. Both routes return them and the page builds every label from them. `stall_s` must stay
  well above the slowest honest share interval: there is no vardiff (memory
  `project_pool_db_capacity`), so a tight value paints small rigs amber.
- **Click the address (or anywhere on the row) to expand.** The detail is a second `<tr>` from the
  same `AdminTable` `row()` call, so paging still counts miners. It shows status with the reason,
  1 h hashrate, blocks found, retained shares, first/last seen, ownership-proof COUNTS, Goblin
  username, ban reason, Tor pause (Clear button here now) and pending payouts, plus a rigs table:
  status (mining / stalled / offline), 10 min and 1 h hashrate, 1 h shares, last share,
  live-session reject/stale %, region(s), connected since, `donateN` %. Open rows are kept in a
  Set; focus is restored after each repaint (`data-fk`). Copying the address moved to its own ⧉
  `[data-copy]` button.
- **Per-row refresh is rationed.** The review pass found the first build re-reading both detail
  routes — three per-address share reads — for every open row, on-screen or not, every 30 s, and
  with only the single-column `idx_share_address` each of those walked ~31 h of that miner's
  shares (`WHERE grin_address = ? AND created_at > ?` could seek the address but not the window).
  Two fixes, both kept: (1) the 30 s refresh re-reads only the RIGS (one pass:
  `getWorkersForAccount` takes an optional short window and returns both hashrates), only for open
  rows actually on screen, and not while the tab is hidden; the account facts are read on open,
  after an action on that miner, and otherwise at most every `FACTS_MAX_AGE_S` (5 min); a failed
  read is retried on the next refresh, never in a loop; the row prints both "as of" times;
  collapsing a row drops its cached data. (2) The index itself — see *Backend*.
- **One dialog at a time.** The backdrop blocks a second click, but keyboard focus can Tab out to a
  row button behind it, and a second open used to add a second submit listener to the same form,
  so one Submit banned BOTH addresses. `askDialog` now cancels an open dialog before opening.
- **Chips** (All / Mining / Degraded / Connecting-when-non-zero / Offline / Banned, with counts)
  replace the two checkboxes and double as the dot legend. **Sortable** headers (status puts
  problems first; numbers descend first).
- **Ban / unban / clear-pause use an in-page dialog**, not `prompt()`/`confirm()`: the step-up
  dialog opens right after it, and a native dialog followed by another is the throttled pattern
  of design §13.12r.
- **"Recent payouts for this address →"** links to `payments.html?q=<address>`. NEW `AdminTable`
  option `urlQuery: true` prefills a table's search from `?q=` (opt-in per table, value only ever
  set as the input's `.value`); `payments.html` opts in. That page loads the 100 most recent
  payouts, hence "recent". It deliberately does NOT link the public account page: that page
  writes the address into the viewer's `localStorage`, and the site stopped emitting `?addr=`
  links in audit §J11-1.

**Backend.**
- `GET /api/admin/miners` no longer runs `COUNT(*)` / `MAX(created_at)` over `shares` per listed
  row. Those walked every retained share (about 31 h) twice on each 30 s refresh of a 500-row page,
  on the synchronous DB the stratum server shares. The replacement is one `RECENT_SQL` pass over
  the last `seen_s`, grouped by (address, rig), plus the in-memory sessions.
  ⚠ Its upper bound `created_at <= ?` is load-bearing: with it the plan is
  `SEARCH shares USING INDEX idx_share_created (created_at>? AND created_at<?)`, and without it
  `SCAN shares USING INDEX idx_share_address_created`. The test pins both.
- **`shares(grin_address, created_at)` index** (`idx_share_address_created`, `lib/db.js`) REPLACES
  the single-column `idx_share_address` (dropped by the same schema list, so an upgraded DB loses
  it on the next boot). Every per-address shares read is now bounded by its window:
  `SEARCH (grin_address=? AND created_at>?)` for the worker breakdown and hashrate (the admin rig
  rows AND the public account page), index-only for the detail route's COUNT/MAX, and no temp
  b-tree for `shares.js` per-address `ORDER BY created_at`. `EXPLAIN` over every shares query
  shape gave identical plans with or without the old index, so keeping it would only have added
  a third index write per accepted share. It is built once, on the first boot after upgrade, over
  the retained ~31 h, inside `initDb` — before `stratumServer.start()`.
- **The list is capped at `limit` (max 1000, up from 500), and it is no longer "top N by
  balance".** That cut a brand-new miner (balance 0 until a block matures) off the page while it
  was mining, and the chips undercounted exactly the rows they exist for. Now
  (`minerStatus.listPriority`): every account that MINED inside `seen_s` (biggest Σdiff first),
  then admin-banned ones, then share-less sessions, then the rest by balance; the result is
  returned in balance order. Share-less sessions go LAST because stratum login is unauthenticated
  and creates the `miner_accounts` row (`stratum-server.js` `ensureMinerExists`), so anyone can
  mint them. The response adds `total_accounts`, `mined_accounts` and `truncated`. `?search=`
  keeps the old by-balance behaviour with `offset`, now as ONE string (an array is ignored),
  bounded to 100 chars, with LIKE's `%`/`_` escaped; `offset` does not apply without it.
- **Seven pre-existing full scans of `shares` closed** (outside this page; found by the plan sweep
  for the index). All had a ONE-SIDED time range grouped by a column that leads another index, so
  SQLite walked that whole index — the entire ~31 h table — to skip a small sort:
  `created_at > ? GROUP BY grin_address` in `recordHashrates` (**every 60 s**) and `getTopMiners`;
  `SELECT DISTINCT grin_address … created_at >= ?` in `updateStreaks` (daily); and
  `created_at > ? GROUP BY region` (a range on `idx_share_region`'s SECOND column cannot seek) in
  `/api/pool/topology`, `/api/pool/stats/regions`, `/api/pool/connect/suggest` (all PUBLIC) and
  `/api/admin/health/gateways`. Each now carries an upper bound (`AND created_at <= now`, or the
  day's end for the streak), which flips the plan to `SEARCH … idx_share_created` over the window;
  results are unchanged (no share is stamped in the future). **NEW `scripts/test-shares-plans.js`**
  (in `npm test`) guards the whole class rather than a hand list: it pulls EVERY SQL literal that
  names `shares` out of `index.js` and `lib/*.js` (25 today, floors per file so a broken extractor
  fails loudly), plans each on the real schema without ANALYZE, and fails on any `SCAN shares`
  not in its allowlist (one entry: the one-off difficulty-unit migration). Run against the
  committed pre-fix code it fails on exactly these seven.
- New list fields: `status`, `workers_online`, `workers_total`, `workers_missing`,
  `workers_stalled`, `hashrate_gps`, `last_share_at` (now null past `seen_s`; the page then shows
  "seen …" from `last_seen_at`) and `banned_at`, plus top-level `windows`. **`shares_count` was
  dropped:** it counted what retention had left, so it fell at every prune. The detail route
  still returns it, labelled "Shares retained".
- NEW `GET /api/admin/miners/:addr/workers` (`secureAdmin`, 404 for an unknown address) returns
  ONE `getWorkersForAccount(addr, seen_s/60, hashrate_s/60)` call (the new optional third argument
  adds `hashrate_gps_short` from the same pass; the public two-argument call's output is
  unchanged), plus region and connected-since from the live sessions, problem rigs first. It
  carries no rig IP or password.
- Admin routes are not in `API_DOC_META`, so the public API reference is unchanged.
- **Page side of the cap:** it asks for the maximum, prints a scope line ("Showing N of T
  accounts: every one that mined in the last 1 h (M), banned ones, then the rest by balance", or
  "All T accounts"), and when the list IS capped the address filter also asks the server
  (`?search=`, 8+ characters, 300 ms debounce, stale replies dropped by a sequence number). Found
  accounts the list lacks are added to the view — not to the chip counts, which describe the
  server's list — and re-looked-up on each refresh; a `?q=` deep link does the same after the
  first load. NEW `AdminTable` option `onSearch(q)` (after each keystroke; a throw is caught).

**Tests.** NEW `scripts/test-admin-miners.js` (50) covers the status rules, the windowed query's
results and plan (with a control showing the one-sided form SCANs), both real route handlers
against a throwaway DB, the workers route's single share pass and the unchanged public output,
the composite index (present, old index gone, the per-address plans), and the capped list (a
zero-balance miner mining now beats the richest idle account; banned beats a share-less session;
totals; `?search=` escaping and array input; the priority read SEARCHes `miner_accounts`).
`test-admin-panel.js` §11 was updated (the 🧅 button is gone) and gained §12 (21 checks) for the
page, including the facts gate, the one-dialog guard and the cap handling. `npm test` exit 0.
Three one-shot jsdom renders against stubbed data exercised expand, refresh, chips, sort, the ban
dialog and `?q=`; the fetch cadence (open → facts + rigs; refresh → rigs only; off-screen or
hidden → none; facts at 5 min, after an action, and after a failure) and one-Submit-one-ban; and
the capped-list lookup (no call under 8 characters or on an uncapped list, one debounced call,
found row listed but not counted, re-looked-up on refresh without doubling, `?q=` deep link).

**Not done / open.**
- Nothing has run against a live pool or in a real browser, and nothing on a VPS.
- `connecting` is also what a stranger opening a session under someone's address looks like. It is
  shown amber-hollow and never counted as a rig. Whether to tell it apart from a slow first share
  is left open.

### 10.13 Games platform (design §19; 2026-09-27, add-ons — NOT VPS-tested)

The contract is design §19; the per-part deltas are in §19.15. This section records what each part
built in the pool and what a reader of the pool code needs to know.

#### Part 2: pool link (the only pool-side change)

**All logic lives in NEW `lib/games-link.js`** (`createGamesLink()`). `index.js` gained the
require, `const gamesLink = createGamesLink()` + `app.use(gamesLink.internal)` **above
`express.json()`**, `gamesLink.attach({...})` + `gamesLink.mountAdmin(app, {...})` right after the
branding route, `cfg.games = gamesLink.publicFlag()` in the branding builder, `'games'` in
`STEP_UP_SETTINGS_SECTIONS`, and one clause in the branding row of `API_DOC_META`. Nothing touches
the stratum, share, block, reward or payout paths.

- **Why two phases.** The internal routes must see the request before `express.json()` (the secret
  is checked before any body is read, and the verify cap is 2 KB, not express.json's 100 KB), but
  the DB and settings only exist inside `initializePool`. So the middleware is mounted at the top of
  the file and gets its dependencies from `attach()`, which runs before `app.listen`.
- **`/internal/*` guards, in order:** (1) a forwarding header (`X-Forwarded-For` / `X-Real-IP`) or a
  non-loopback socket → 404; (2) link file missing/short → 503 `link_not_configured`; (3) wrong or
  missing `X-Games-Link` → 401 `unauthorised` (one `timingSafeEqual`); (4) exact route match, else
  404. So a request that came through nginx cannot even learn whether the secret is configured.
- **Link secret:** path from pool.json `games_link_secret_file` (default
  `/opt/grin/conf/grin_pubgames_link_<net>`, `lib/config.js`). It is re-stat'ed at most once a
  second and re-read when its mtime or size changes, with surrounding whitespace trimmed. The games
  side must trim the same way (Part 4).
- **verify-proof** requires `client_ip` and refuses a loopback/unspecified one (a broken X-Real-IP
  chain would put every player in one throttle bucket). It calls the real `verifyOwnerProof` with
  that IP, audits `owner_proof:games_login:ok|deny`, and answers **200** with either
  `{ok:true, method, slot, age_seconds}` or `{ok:false, reason}`. Errors carry `error`, never
  `reason`.
- **activity** is one statement with `INDEXED BY idx_hashrate_time`. The planner already picks that
  index without the pin (`SEARCH … (recorded_at>? AND recorded_at<?)` + a temp b-tree for the
  GROUP BY). The pin makes a dropped index a loud error instead of a scan on the stratum process.
- **config** answers 503 `settings_unavailable` rather than a guessed `off`, so the games service can
  keep its last known mode (§19.2).
- **Admin proxy** `ALL /api/admin/games/*` → games `/internal/admin/*`. Step-up is decided by
  `requiresStepUp()`: GET never; the six §19.11 fast writes (fixed POST paths, see §19.11) never;
  **every other write always, so a games admin route added later is step-up until it is listed**.
  Paths are charset-checked raw (no `%`, no dot-segments), bodies are re-serialised JSON ≤ 64 KB,
  2 s budget. Games down → 503 `games_offline`, non-JSON → 502. Each step-up call writes one
  `games_admin` audit row. `GET /api/admin/games-link` (not proxied) feeds the Settings → Games
  health line.
- **Probe:** `GET 127.0.0.1:<games_port>/play/api/health` at attach, then every 60 s (unref'd, 1 s
  hard timeout, `agent:false`). Healthy = 200 + `ok:true` + the pool's own network. A flip calls
  `invalidateBranding`, so the nav reacts on the next branding fetch rather than after the 60 s memo.
- **Settings:** new `games` section `{ mode:'off', chat_enabled:false }` with strict validators
  (exact enum; booleans or the exact strings `'true'`/`'false'`, stored as `value_type 'boolean'`).
  The reader treats anything unexpected as off. `games_port` / `games_link_secret_file` are
  **pool.json keys, not settings** (§19.15 *Part 2*). A bad value in pool.json disables the link and
  logs one line; it never blocks the pool's boot.
- **Nav:** `public-shell.js` NAV gained `{ href:'/play/', label:'Play', icon:'🎮', games:true }`,
  rendered with `data-games="1" style="display:none"` in the header and the footer Pool column.
  `branding.js applyGamesNav` shows it only on `cfg.games.mode === 'on'`.
- **Admin page:** NEW `admin-panel/settings-games.html` (a `<select id="mode">`, because the
  harvester does not handle radios, plus `#chat_enabled` and the health line), linked under
  Settings in `admin-shell.js`. `settings-common.js` gained `loadGamesLinkStatus()` (textContent
  only).

**Tests.** NEW `scripts/test-games-link.js` (169), wired into `test:unit`. It runs the real lib on
a throwaway DB behind an express app mounted in index.js's order, with a fake games server on
`127.0.0.1:0`. `test-public-leakage.js` gained `[games]` (5). Pool `npm test`: **2108 → 2282
passed, 0 failed** (22 → 23 files).

**Deploy note.** This is the one planned pool restart of the whole games build (§19.2 impact budget
#1). With mode `off` (the default) and no games service installed, the only runtime change is one
refused localhost connection a minute from the probe.

**Not done / open.** Nothing ran against a live pool or on a VPS. The nginx
`location ^~ /internal/ { return 404; }`, the link file itself and `id grinpool` are Part 3's.

#### Part 3: operator side (bash, menu `P`)

**All of it lives in NEW `scripts/lib/07_lib_pool_games.sh`** (prefix `pgs_`, plus the menu
`pool_games_menu`), sourced by the pool script right after the backup lib. The pool script gained
only hooks: the header menu comment, the `P` row + dispatch + no-pause entry, `games_port` in
`pool_write_conf_key`'s numeric set, `pgs_deploy_code` at the end of `pool_deploy_code`, two lines
in the vhost's `:443` block, a third `C) Cron` toggle, and a cleanup group. The backup lib and the
migrate lib gained the games-DB hooks below.

**The rule of the file: nothing under `P` restarts, stops or reloads `grin-pool-manager`.** Every
state-changing `systemctl` call names `$PGS_SERVICE`; the pool unit is only read (`systemctl show`
for its `NRestarts`, printed by P → 5 so the operator can prove the rule). nginx is reloaded, never
restarted. `P → 3` may call `pool_setup_nginx` to add the include to an older vhost, which is itself
a reload only.

| Key | Function | What it does |
|---|---|---|
| 1 | `pgs_install` | Refuses without the pool unit, `grinpool` or Node ≥ 24. Creates `grinplay` (nologin, own group; removed from `grinpool`/`grinsecret` if found there), checks `id -gn grinpool` = `grinpool`, creates the dirs (code `root:grinplay 750`, data `grinplay 700`, `o+x` on `/opt/grin` + `/opt/grin/conf` for traverse), the link secret **once**, the two pool.json keys **only if absent**, deploys code, pre-creates the log, writes the unit + logrotate, enables and (re)starts the games only, waits ≤ 15 s for `/play/api/health`. Refreshes the daily backup wrapper when a schedule is on, so it starts archiving the games DB. |
| 2 | `pgs_deploy_code` | Stages `server/**` + each game's `manifest.json`/`rules.js` (code) and `shell/**` + each game's `frame/**`/`rules.js` (web) in a temp dir, writes `version.js`, then ONE `rsync -a --delete` per tree, then re-applies owners/modes. Restarts only the games service, only if it is running. Also runs at the end of the pool's `9) Deploy new code` when games is installed; a games failure there is a warning, never a failed pool deploy. |
| 3 | `pgs_setup_nginx` | Zones via `nginx_ensure_rate_limit_zones`, the snippet (temp file + rename, the previous copy kept in `/tmp` for rollback), the vhost include check, `nginx -t` + reload (rollback + reload on failure), then the route check. |
| 4 | `pgs_service_menu` | Start / stop / restart the games unit. |
| 5 | `pgs_status` | Unit state + `NRestarts` + last exit (78 named), listener (red unless `127.0.0.1` only), health JSON, DB size + `schema_version`, link file owner/mode, mode + chat from the pool, "401 without the secret", snippet + include present, the pool's own `NRestarts` / `ActiveEnterTimestamp`. |
| 6 | `pgs_view_logs` | The last 50 lines, paged. |
| 7 | `pgs_rotate_secret` | `[y/N]`, new secret via temp file + rename, then one probe with the new secret. No restarts. |
| 8 | `pgs_uninstall` | Service, unit, snippet + zones (then test + reload), web + code dirs, logrotate, VACUUM cron, link file. The DB only on a second `[y/N]`. Keeps the `grinplay` user and the pool.json keys. |

**How the secret is kept out of sight.** It goes `openssl rand -base64 48 > tmpfile` (a redirect,
not argv) in a `umask 077` subshell, is `chown grinplay:grinpool` + `chmod 0440` **before** the
rename, and is never read into a shell variable. P → 5 and P → 7 read it inside `node`, which is
given the file PATH, and print one word. The unit carries only `GAMES_LINK_SECRET_FILE`.

**Unit** (`/etc/systemd/system/grin-games[-testnet].service`): `User=grinplay`, the six variables
`lib/config.js` knows (`GAMES_NET`, `GAMES_PORT`, `GAMES_DB`, `GAMES_LINK_SECRET_FILE`,
`GAMES_GAMES_DIR`, `POOL_INTERNAL_URL` from pool.json `service_port`) + `NODE_ENV`, `ExecStart=node
--disable-warning=ExperimentalWarning index.js`, `Restart=on-failure`, `RestartPreventExitStatus=78`,
`StandardOutput/StandardError=append:` the log, every D16 limit, plus `PrivateDevices`,
`ProtectKernelTunables`, `ProtectKernelModules`, `ProtectControlGroups`, `RestrictSUIDSGID`,
`LockPersonality`. `ReadWritePaths=-<data dir>` only. No `Requires=`/`BindsTo=` in either direction.
Logrotate uses `copytruncate` (no reopen signal exists; systemd holds the descriptor).

**nginx.** Zones `<svc>_games` 600 r/m and `<svc>_gamelogin` 20 r/m in
`/etc/nginx/conf.d/script07-<svc>-games.conf`. Snippet
`/etc/nginx/snippets/script07-<svc>-games-locations.conf`: `= /play` (301), `^~ /play/api/login`
(4 KB), `^~ /play/api/` (64 KB), `^~ /play/games/` (frames: no common snippet, own nosniff /
Referrer-Policy / HSTS + the frame CSP), `^~ /play/` (shell: common snippet + shell CSP). The two
static locations use the pool's `<svc>_static` zone. In `pool_setup_nginx`'s `:443` block, before
`location /`: `location ^~ /internal/ { return 404; }` and `include
/etc/nginx/snippets/script07-<svc>-games-*.conf;`. **The route check** runs `curl --resolve
<domain>:443:127.0.0.1`, so a CDN cannot answer for the origin: `/play/` (200, or 403/404 = no shell
yet), `/play/api/health` (200, or 502 = games stopped), `/internal/x` and `/internal/games/config`
(both must be 404, else it is an error).

**Backup / restore (D18).** `_pbk_make_tar` adds a snapshot of `$PGS_DB` through the SQLite backup
API, in the same stage dir, appended after `pool.db`. It is best effort: a failure is a warning and
never rc 2. No `cp` fallback, unlike `gbe_snapshot_db`: a raw copy of a live WAL DB is not a
snapshot. `-wal`/`-shm` a root open may create are chowned back to `grinplay`. The daily cron
wrapper does the same, logging `WARN` lines. `_pbk_restore_extract` **excludes** the games DB, and
both `pbk_restore` and Migrate IN then call `pgs_restore_db_from_archive`: `[Y/n]` (EOF declines),
stop games, move the old DB **with its sidecars** aside to `grinium-games.db.pre-restore[-wal|-shm]`,
place the restored file, `chown grinplay` 600, start games again if it was running. On a box without
the games yet, the file lands root-owned and P → 1 takes ownership.

**Cron.** `C) Cron` → 3 (shown only when games is installed): weekly games VACUUM, Sunday **03:30**
UTC (the pool's is 03:00), stops the games only, runs the VACUUM **as `grinplay`** via `runuser` from
`/`, restarts from a trap.

**Cleanup.** `Z) Cleanup` shows two presence marks and runs group **1b** (everything but the DB,
`[Y/n]`) and **1c** (the DB, `[y/N]`, default KEEP) right after the services group, while the pool
vhost that includes the snippet still exists.

**Verified locally:** `bash -n` on the pool script and the three touched libs; the snippet heredoc
rendered with the mainnet constants and read; `_pgs_stage_trees` run against the checkout (stage
layout + `version.js`). **Owed on the VPS (checkpoint A):** everything else, including that the
glob include matching nothing passes `nginx -t`, `MemoryMax` on the box's cgroup, `runuser` present,
and the frame CSP's `sandbox` directive not breaking the chess frame (Part 6).

#### Part 4: login, sessions, activity sync, plays ledger (games service only)

**VPS checkpoint A was skipped by the operator** (2026-09-27: installs later), so Part 4 was built
on top of Parts 1–3 with none of them run on a box. **No pool code changed in this part.** Everything
is in `web/07_mining_pool_public/play/server/`:

| File | What |
|---|---|
| `lib/pool-link.js` (NEW) | client for the three `/internal/games/*` routes: secret file trimmed, 32 B–4 KB, re-stat'ed ≤ 1/s; **no** `X-Forwarded-For` / `X-Real-IP`; 2 s whole-exchange timeout; typed `PoolLinkError` codes `link_not_configured` / `link_down` / `link_unauthorised` / `link_rejected` (+`field`) / `pool_error` / `bad_response`; every response shape-checked (activity rows with a bad address, the other network's prefix, a duplicate or a non-integer count are dropped and counted) |
| `lib/ratelimit.js` (NEW) | LRU-bounded token buckets; a failure backoff whose record survives expiry (so escalation is reachable) and whose overflow never evicts a live lockout |
| `lib/ledger.js` (NEW) | `post()` — the only writer of `players.plays` / `points`, balance + ledger row in one transaction, no overdraft (`LedgerError no_plays`), exactly-once by `uq_ledger_ref`; `verify()` reports drift, never fixes it |
| `lib/plays.js` (NEW) | the activity sync (§19.6): hour-aligned contiguous windows from the watermark to now − 120 s, one transaction per window, `UNIQUE(window_from)`, ≤ 24 pool calls per tick, > 7 d behind = one skipped row, seconds clamped to the window |
| `lib/sessions.js` (NEW) | sessions (§19.5): sha256-hex token hash, 14 d hard, `last_seen` ≤ 1 per 5 min, 20 live per address, `chat_ok_after` with the 1 h floor, `ip_coarse` /24 · /48, `ua_hint` "Browser on OS" (raw UA never stored), purge after 30 d |
| `lib/auth.js` (NEW) | routes `POST /play/api/login` · `logout` · `logout-all`, `GET /play/api/me` · `sessions`; the login limiter chain; chat status |
| `lib/mode.js` (NEW) | the pool's `games.mode` cache: off until the first answer, last known ≤ 10 min, single-flight, 60 s unref'd timer, transitions logged once |
| `lib/settings.js` (NEW) | games-owned settings (`settings` table) with a typed spec; Part 4 keys: `minutes_per_play`, `plays_daily_cap`, `plays_balance_cap`, `chat_min_proof_age`, `chat_requires_password` |
| `lib/mask.js` (NEW) | the pool's `maskAddr`, copied |
| `lib/app.js` | builds the services; `publicRoute()` = mode gate (off → 404) + CSRF layer 3 for every public route except health; `registerJobs()`; `start()`/`stop()` for the mode timer |
| `lib/http.js` | `sameOriginOk()`; `HttpError` carries response headers (`Retry-After`); five new message codes |
| `index.js` | registers the jobs, starts the mode cache after `listen` |

**Login, in order** (each step before anything dearer): body shape (`GRIN_ADDR_RE` + this network's
prefix, proof 1–256 chars, no other keys) → a loopback client IP is refused (400 `client_ip`, pool not
called) → per-IP and per-(address, IP) failure lockouts → per-IP bucket (10, refilling 1/min) →
per-address failure budget (20, refilling 1 per 3 min; a /24 · /48 with a session for that address in
the last 30 d passes when it is spent) → ban → **one** pool verify with the real IP. Only `no_match`
counts as a failure. Failure answers: 401 `login_failed` + `reason` + `hint` (the account page's own
sentence), 429 for `too_many_attempts` and every local limit (with `Retry-After`), 503
`pool_unavailable` for `lookup_failed` and any link error, 403 `banned`.

**Chat status** in `/me` (`auth.chatStatus`): `chat_off` · `muted` · `anchor_proof` ·
`password_required` · `proof_too_new` (+ `available_at`). Part 8 adds the recent-mining gate there.

**Maintenance jobs:** 5 m `activity_sync` (budget 15 s); 1 h `session_purge`, `limiter_sweep`,
`ledger_verify` (logs at most 20 drift lines).

**Tests.** NEW `scripts/test-auth.js` (163): the real pool-link against a stub pool on `127.0.0.1:0`
(headers sent, secret trim / rotation / short / missing / oversized, every error code, the 2 s
bound), the limiters (escalation after expiry, overflow), the ledger (1000 seeded random ops keep the
invariant; a tampered balance is reported and left alone), the sync (window shape, idempotence, two
concurrent syncs, UTC midnight, clamp, both caps, catch-up bound, the 7-day skip, link failures),
login / sessions / `/me` over a loopback server with a stubbed pool (mode gate, cookie attributes,
hashed token, every limiter, ban, CSRF, D9 variants, the 30-day known-IP window), the mode cache,
and log hygiene. Four mutations (no clamp, no Origin check, backoff record deleted at expiry,
`trivial_password` counted) each turned the suite red. Games `npm test`: **155 → 318 passed, 0
failed** (1 → 2 suites). The `test-skeleton.js` calls to `buildApp` now pass a full config
(`appConfig()`), since the app builds the pool link at construction.

**Owed on the VPS** (with checkpoint A, whenever the operator installs): a real login through nginx
(X-Real-IP reaching the service, the Origin check against the real Host), the pool's `games_login`
audit rows, the first sync's pool cost (≤ 24 activity calls, then one per 5 min), and the mode
following the admin switch within ~60 s.

#### Part 5: match platform, chess, bot (games service only)

Built on Parts 1–4 with nothing run on a box (checkpoint A skipped). **No pool code changed.**
Contract: design §19.7–§19.8; deltas: §19.15 *Part 5*.

| File | What |
|---|---|
| `play/games/chess/manifest.json` (NEW) | `kind: match`, modes bot + pvp, bot levels 1–3, UCI `move_pattern`, move times 1 / 3 / 7 days (default 3), `max_plies` 600, points bot 1/2/3, PvP 10/5 |
| `play/games/chess/rules.js` (NEW) | our own rules on a 0x88 board, UMD (global `GrinChessRules` in the frame): FEN in/out, UCI moves, `initial` · `toMove` · `legal` · `apply` · `status` (checkmate, stalemate, automatic threefold with FIDE en passant identity, automatic fifty-move, dead material, 600 plies) · `bot`. The bot is seeded splitmix32 over FNV-1a of (seed, ply, FEN, level): level 1 random, level 2 greedy material with mate-in-1, level 3 2-ply alpha-beta over material + Michniewski piece-square tables, `BOT_NODE_BUDGET` 20 000 |
| `server/lib/registry.js` (NEW) | `loadGames()`: real-path containment, size caps (manifest 16 KB, rules 512 KB), a strict manifest validator (unknown keys refused; `skill` / `chance` refused as reserved), rules.js evaluated in a sandboxed `vm` context, a smoke test on the start position; a bad game is skipped with one `[games] skipped …` line |
| `server/lib/matches.js` (NEW) | routes `GET /play/api/games`, `POST /play/api/matches`, `GET …/matches/mine`, `GET …/matches/:id`, `POST …/:id/move`, `POST …/:id/resign`; the replay + integrity check, `advance()` (settle, or bot replies until a human is to move), `settle` / `abort` (`UPDATE … WHERE state='active'` must change exactly one row), the points cap, timeouts, the purge |
| `server/lib/app.js` | builds the registry (injectable for tests) and matches; the match routes go through `publicRoute()`; jobs `match_timeouts` (5 m), `bot_moves_purge` (1 h) |
| `server/lib/settings.js` | `bot_play_cost` (1, 0–10), `points_daily_cap` (100, 0–100 000) |
| `server/lib/http.js` | ten message codes (`unknown_game` … `game_error`) |

**A move, in order** (one `BEGIN IMMEDIATE`): the match exists (404) → the caller holds a seat (403
`not_your_match`) → it is active (409 `not_active`) → a passed deadline is finalised and committed
(409 `timeout`) → the game is loaded (503 `unknown_game`) → it is the caller's turn (403) → `ply`
equals the stored ply (409 `stale`) → `move_pattern` → replay of the move list (must reach the stored
position) → `rules.apply` (400 `illegal_move`) → status → settle, or the bot's reply → status → … A
throw or a malformed return from any rules call answers 500 `game_error` and rolls the whole
transaction back.

**Tests.** NEW `scripts/test-matches.js` (133):
- **Perft:** start d1–4, Kiwipete d1–3, and three more reference positions (en passant pins, promotion
  and castling).
- **Rules cases:** castling through and out of check, a rook captured at home, en passant and its
  rank-pin, under-promotion, a pinned piece, every automatic game end, and repetition identity with an
  unusable en passant square.
- **Bot:** determinism across calls and separate sandbox loads, legality over 18 self-play games, mate
  in 1 found at levels 2–3, level 3 never allowing a mate in 1, and the budget cut-off.
- **Registry:** 15 planted folders, each good or bad for one reason, including a junction pointing
  outside the games dir.
- **Match API** over a loopback server with a stubbed pool: create validation, CSRF, `no_plays` with
  nothing left behind, two racing moves (exactly one wins), stale / illegal / forged / another
  address's match, the rate limit, public masking with no seed, resign exactly once, both timeout
  paths (sweep and lazy), win / draw / `max_plies` points with the daily cap and its UTC reset, free
  games, a throwing rules.js, a tampered position, `/mine` paging, mode off, the retention watermark,
  the ledger invariant and `EXPLAIN` on the hot reads.

Games `npm test`: **318 → 451 passed, 0 failed** (2 → 3 suites).

**Owed on the VPS** (with checkpoint A, whenever the operator installs): the registry's boot line on
the box (`[games] loaded chess 1.0.0 …` from `/opt/grin/pubgames/<net>/games/`); a bot game at each
level through nginx once Part 6's shell exists; the `[matches] slow bot move` warning never
appearing on the real CPU.

#### Part 6: the `/play/` shell + the chess frame (one pool static file, one bash hunk)

Built on Parts 1–5 with nothing run on a box. Contract: design §19.7 + D4 + D13; deltas: §19.15
*Part 6*. **No pool backend code changed** — the one pool file is a static script served by nginx,
live with the pool's web deploy and no restart.

| File | What |
|---|---|
| `play/shell/index.html` (NEW) | the page: pool header/footer (`public-shell.js` → `public-theme.js` → `branding.js`), states loading · offline/closed · sign-in · signed in, the Plays/Points/Signed-in-as placard, devices fold + log out / log out everywhere, the board panel (G-02), new game vs the bot (G-03), My games (G-04), "How plays are earned" (G-05). `<html data-untrusted-html="exempt">`; no inline script; own assets stamped `?v=__GRIN_PLAY_VERSION__` |
| `play/shell/js/play-api.js` (NEW) | `PlayApi.get/post` under `/play/api/`: same-origin, `no-store`, `redirect:'error'`, JSON content type on writes, 20 s abort. Offline = network error, non-JSON content type, a body without `ok`, 503 `shutting_down`/`db_unavailable` |
| `play/shell/js/frame-host.js` (NEW) | `FrameHost.create`: `<iframe sandbox="allow-scripts" allow="" referrerpolicy="no-referrer">` at `/play/games/<id>/frame/?v=<version.js>`; inbound only from `contentWindow`, exact-key schemas, move checked against the manifest `move_pattern`; `sendState` rebuilds §19.7's fields so nothing else can ride along; state/theme held until `ready` |
| `play/shell/js/play-shell.js` (NEW) | the controller: `/me` → signed in (401 → sign-in, 404 → "Games are closed", offline → retry), `/games`, `/matches/mine` (paged), opens the active bot game or `#m=<id>`, create / move / resign, two-click confirms, `/me` every 5 min while visible. No `innerHTML` |
| `play/shell/css/play.css` (NEW) | layout only, pool tokens only; `[hidden]` wins on this page; board 8:9 capped at 560 px; one column under 900 px |
| `play/games/chess/frame/{index.html,game.js,game.css}` (NEW) | 64 button squares (roving tabindex, arrows, Enter/Space), click-click + pointer drag, promotion picker, legal-target dots/rings, last-move tint, check marker (`rules.inCheck`), orientation from `you`, a provisional board from `rules.apply` while a move is in flight, input locked until the next `state`. Classic scripts; own dark/light palette |
| `public_html/js/public-shell.js` (pool) | every rendered href is site-absolute via `abs()`, active item compared by path; no ad slots / `ads.js` on a `data-untrusted-html="exempt"` page |
| `scripts/lib/07_lib_pool_games.sh` | `_pgs_stage_trees` replaces `__GRIN_PLAY_VERSION__` in every staged `*.html` after the hash; the "no shell" notice is a warning now |

**The blog permalink bug this fixed.** `post.html` is served at `/blog/<slug>` with no `<base>`, so
every header and footer link on a blog post resolved under `/blog/` (`/blog/index.html` …) and 404'd.
The same links would have broken on `/play/`. Absolute hrefs fix both.

**Tests.**
- NEW games `scripts/test-shell.js` (68): static rules on both HTML pages and all shell/frame JS (no
  inline script, no `on*`, no module script, no HTML sink, no eval, never `allow-same-origin`, every own
  asset stamped, the untrusted-HTML opt-out, load order, no `name=` on the login inputs); `FrameHost`
  in a `vm` with a fake DOM (ready gating, source check, exact schemas, a foreign-realm object dropped,
  extra state fields dropped, destroy); `PlayApi` with a fake fetch (every offline rule, incl. a body
  that parses but is not served as JSON); the nginx snippet's frame CSP. Mutation-checked: removing
  the move schema, the source check, the content-type rule, the sandbox value or a `textContent`
  each turns it red.
- Pool `test-games-link.js` 169 → 173: hrefs through `abs()`, no relative literal, `abs()` itself, the
  ad gating.
- A one-shot headless-Edge probe over CDP (127.0.0.1 server with the real nginx headers and the
  STAGED tree, stubbed `/play/api`, killed after): 48/48 — 1280 and 390 px in dark and light (0
  console errors or CSP violations, no horizontal overflow, square board, frame theme follows), a move
  through the frame (POST body exactly `{ply, move}`, bot reply drawn), junk and foreign messages
  dropped, the frame cannot read `document.cookie`, the parent, storage or `/play/api/` (origin
  `null`), login refusals, links absolute + Play active, no ads, 502 HTML → offline, 404 → closed, a
  direct frame visit sandboxed.

Games `npm test`: **451 → 519 passed, 0 failed** (3 → 4 suites).

**Owed on the VPS** (with checkpoint A): `P → 2` deploy shows the stamped URLs in
`/var/www/grin-play/index.html`; a bot game at each level through nginx and Cloudflare in preview;
the real CSP headers on `/play/` and `/play/games/` (`curl -sI`); a blog permalink's header links.

#### Part 7: leaderboards, events, the admin Events page

Built on Parts 1–6 with nothing run on a box. Contract: design §19.9 + §19.11 + D15 + D17; deltas:
§19.15 *Part 7*. **No pool backend code changed** — two admin-panel static files (a new page and a
nav entry), live with the pool's web deploy and no restart. The pool-side step-up rule the page
relies on (`FAST_WRITES` in `lib/games-link.js`) was written in Part 2 and already names these routes.

| File | What |
|---|---|
| `play/server/lib/leaderboard.js` (NEW) | `GET /play/api/leaderboard?board=&game=&mode=&period=`: points held (`players`), rating (`ratings`, ≥ 5 rated games), wins / match points per game + mode over the current UTC day, ISO week, month or all time (`results_daily`). Masked names, `own` flag + `you` rank for the caller, 60 s cache over a closed key space |
| `play/server/lib/events.js` (NEW) | the platform: validation, lifecycle (`tick()`), `finalise()`, public routes `GET /play/api/events` + `/:id`, admin routes under `/internal/admin/` (`event-kinds`, `events` list / create, `events/:id` get / update, `…/cancel`, `…/finalise`) |
| `play/server/lib/events/{game_results,mining_minutes,active_days}.js` (NEW) | one module per kind: `validate` · `compute` · `describe` · `gameId` (+ `fields` for the admin form). Reads `results_daily` / `activity_daily` only |
| `play/server/lib/events/index.js`, `_rules.js` (NEW) | the explicit kind list (a new kind = a module + one line here); the rules helpers (`RulesError`, strict keys, typed ints / enums) |
| `play/server/lib/admin.js` (NEW) | the `/internal/admin/*` guard, run before the body is read: forwarding headers or a non-loopback peer → 404; link secret → 401 / 503; `X-Admin-User` → 400; `X-Admin-Stepup: 1` on every non-FAST write → 403 `step_up_required`. `audit()` writes the `mod_actions` row |
| `play/server/lib/badges.js` (NEW) | the eight badge ids + labels; parsing of `players.badges_json` |
| `play/server/lib/app.js` | builds admin / leaderboard / events; public routes through `publicRoute()`, admin routes straight on the router; jobs `event_transitions` (5 m, after `activity_sync`) and `mod_actions_purge` (1 h, 365 days) |
| `play/server/lib/http.js` | a route `guard` option (runs before the body is read); five message codes |
| `play/server/lib/pool-link.js` | `checkSecret(given)` → `ok` / `wrong` / `not_configured`: the admin guard gets a verdict, never the secret |
| `play/server/lib/auth.js` | `/me` gains `badges` `[{ id, label, event_id }]` |
| `play/shell/js/play-boards.js` (NEW) | the G-06 panel: Leaderboards / Events tabs (ARIA tablist, arrow keys), board + period pickers, ranked tables, the event list, detail with rewards and standings. Follows the page state from `play-shell.js`'s `play:view` event; shown signed in or out; no polling; no `innerHTML` |
| `play/shell/index.html`, `js/play-shell.js`, `css/play.css` | the G-06 section, a badges line on the account strip, a sentence on events in G-05; `setView()` sets `body[data-play-view]` and fires `play:view`; tab / table / chip styles from the pool tokens |
| `back-end-pool/admin-panel/games-events.html` (NEW) | event form (kind → rule fields from `event-kinds`, title, first / last UTC day as date inputs, reward tiers, participation), the list (AdminTable, state chips, Edit / Results / Finalise now / Cancel), the results table with full addresses, an in-page confirm dialog; every call through `adminFetch('/api/admin/games/…')` |
| `back-end-pool/admin-panel/admin-shell.js` | NAV: a **Games** group (🎮) holding Events, between Dashboard and Settings |

**Finalising an event, in order** (one `BEGIN IMMEDIATE`): the event is `finalising` (else nothing is
written) → the kind computes over the window's UTC days → addresses with a zero value, or banned at
that moment, drop out → sort by value DESC, address ASC; rank = position → the state flips to `done`
(an `UPDATE … WHERE state = 'finalising'` that must change one row) → per ranked address: an
`event_results` row, the reward (the first tier holding the rank, else participation if the value
reaches it) as a `('points', +n, 'event', 'e:<id>')` ledger row, the badge appended to
`badges_json`. A throw anywhere rolls all of it back and leaves the event `finalising` for the next tick.

**A link-secret 401 is not a logout.** `API.get` / `Auth.fetch` send the admin to `/login.html` on
ANY 401, and the proxy passes the games service's own 401 (pool and games disagree on the link
secret) through unchanged. So `games-events.html` does not use `API.*`: it reads the body, and a 401
whose body has `ok: false` is shown as "rotate the link secret (P → 7)"; only the pool's own 401
(which never carries `ok`) goes to the login page. Parts 9's games pages need the same.

**Tests.**
- NEW games `scripts/test-events.js` (101): UTC periods (ISO week across a year end, leap February);
  ranking and its tie-breaks; kind rules; every board over a loopback server (periods, modes, the
  provisional rating rule, masking, `own` / `you`, parameter refusals, the 60 s cache, mode off);
  the admin guard (forwarding headers, missing / wrong / absent secret, the guard before the body,
  admin user, step-up, `FAST_WRITES` compared as text with the pool's); event validation; the whole
  lifecycle through `tick()`; `mining_minutes` equal to the `activity_daily` sums over exactly the
  window over randomised data; `active_days`; `game_results` with `min_games`, a banned address and
  another mode; exactly-once (a second tick, a direct finalise, a forced replay that must fail whole,
  a duplicate ledger ref); cancel from running and from finalising paying nothing; finalise-now;
  public visibility of cancelled events; every public response scanned for a full address; `EXPLAIN`
  on every board and kind query, and a source check that none reads `matches` or `ledger`; the
  ledger invariant; the `mod_actions` purge.
- Games `test-shell.js` 68 → 78: the panel markup, load order, the `play:view` hook, no polling, the
  only API paths used, badges via `textContent`.
- Pool `test-admin-panel.js` 142 → 153 (section [13]): the NAV group, all calls through the proxy
  prefix, create / update FAST and cancel / finalise step-up per the pool's own `requiresStepUp`, the
  401 split, delegated row buttons, no native dialogs, escaped rows, date inputs with the last day
  included.
- A one-shot headless-Edge probe over CDP (127.0.0.1 server serving the real shell under the real
  shell CSP header, stubbed `/play/api/`, Edge killed with its process tree after): 58/58 at 1280 and
  390 px, dark and light, signed in and out — 0 script errors and 0 CSP violations, no horizontal
  overflow, own row + "you" line, the week range, an event title of `<b>…<img onerror>` rendered as
  text in the list and the detail, provisional / final / scheduled detail states, the Reward column
  hidden until final. `games-events.html` was checked statically only (its inline script parses);
  it has not been opened in a browser.

Games `npm test`: **519 → 630 passed, 0 failed** (4 → 5 suites). Pool `npm test`: **2290 → 2301**,
exit 0.

**Owed on the VPS** (with checkpoint A): the Games → Events page through the real proxy (create,
edit, cancel with the step-up dialog, finalise now); one event from schedule to rewards on the live
activity sync (Part 13's list already has it); the boards and events through nginx in preview.

#### Part 8: chat backend, moderation, and moderators (games service only)

Built on Parts 1–7 with nothing run on a box. Contract: design §19.10 + §19.11 + D9 + **D21 (new:
moderators)**; deltas: §19.15 *Part 8*. **No pool code changed** — the pool's `FAST_WRITES` already
names the four fast chat routes, and every new admin write is step-up by its fail-closed rule.

| File | What |
|---|---|
| `play/server/lib/chat.js` (NEW) | `GET /play/api/chat` (page, or `after` + `rev` + `epoch` → new messages + `changes`), `POST /play/api/chat`, `POST /play/api/chat/:id/report`; body normalisation, the hold rules (word list, links, Grin addresses, reports), the per-address (DB) and per-IP (memory) limits, the in-memory change log, the state helpers moderation uses (`remove` / `approve` / `restore` / `operatorPost`), hourly retention |
| `play/server/lib/moderation.js` (NEW) | the operator's routes under `/internal/admin/` (messages, reports, delete / approve / restore / post, word list, players + mute / unmute / ban / unban / purge / adjust, moderators, settings, mod log) and the moderators' `/play/api/mod/{queue, messages/:id/delete, …/approve, …/mute}` |
| `play/server/lib/db.js` | migration **v2**: `moderators`, `chat_words` (new tables only) |
| `play/server/lib/auth.js` | the recent-mining gate in `chatStatus` (reason `no_recent_mining`); `modStatus` → `/me.moderator` |
| `play/server/lib/settings.js` | nine chat / moderator keys; `setMany` (validate all, write in one transaction) and `meta` |
| `play/server/lib/app.js`, `http.js` | wiring, `GET /play/api/rules`, the `chat_retention` job; the new error messages |
| `play/server/scripts/test-chat.js` (NEW) | 171 checks: normalisation units, every gate and limit, holds, reports, the change feed, the operator routes + step-up, bans revoking sessions, purge, adjust, settings, moderators and every limit on them, retention, no full address in any public answer, `EXPLAIN` on every read |

**How a moderator is set up** (operator): Games → Chat & moderation → *Moderators* → paste the
helper's mining address → *Appoint* (asks for your password). Tell them to sign in to /play/ with their
**rig password** (not an IP) — by default the tools stay off for an IP sign-in — and to have mined
recently enough to chat. They then see a *Moderator queue* under the chat. To stop it: *Remove*, or ban
the address. What they did is in the moderation log as "Moderator grin1…".

Games `npm test`: **630 → 803 passed, 0 failed** (5 → 6 suites; `test-skeleton.js` +2 for the v1 → v2
upgrade, `test-auth.js` pins `chat_min_minutes` 0 where it tests the proof gate alone).

#### Part 9: the chat UI and the admin pages

| File | What |
|---|---|
| `play/shell/js/play-chat.js` (NEW) | the G-07 panel: polling with the change feed, textContent-only rows, Operator / Mod badges from `role`, the author's own held messages, Report, the gate sentence per reason, the moderator queue + Delete / Mute 1 h, the live rules in the "How plays are earned" fold |
| `play/shell/index.html`, `css/play.css` | the G-07 section (anti-scam line first), `#rule-*` spans in the fold, the script tag; chat styles on the theme tokens only |
| `play/shell/js/play-shell.js` | `announceMe()` → the `play:me` event on every `/me` render and on sign-out; the login path passes `moderator` through |
| `back-end-pool/admin-panel/games-admin.js` (NEW) | shared by the three pages: the proxy `call()` (Part 7's 401 rule), `el()` (textContent builder), the confirm dialog, address chips, the mod-log actor ("Moderator grin1…") |
| `back-end-pool/admin-panel/games.html` (NEW) | the Games NAV parent: links + the games-owned settings form built from the service's spec, the fixed floors listed |
| `back-end-pool/admin-panel/games-chat.html` (NEW) | tabs Held / Reports / Visible / Deleted / All with row actions; operator post; moderators; word list; moderation log |
| `back-end-pool/admin-panel/games-players.html` (NEW) | lookup (also `?address=`), Muted / Banned / Moderators lists, mute / unmute, ban / unban, delete recent messages, adjust plays or points, appoint / remove moderator; recent messages, matches, 14 days of activity |
| `back-end-pool/admin-panel/admin-shell.js` | NAV: Games → Overview & settings, Chat & moderation, Players, Events |
| tests | `test-shell.js` +12 (the panel, `play:me`, text-only rendering, API paths, polling, no native dialogs); `test-admin-panel.js` [14] +21 (proxy-only calls, no HTML sink, fast vs step-up paths against the pool's own `requiresStepUp`, NAV); Part 7's NAV pin loosened for the new parent |

**Verified locally:** a one-shot headless-Edge probe over CDP (127.0.0.1 server with the real shell under
the real `/play/` CSP header, stubbed `/play/api/`, Edge killed with its tree after; the script lived in
the session scratchpad only): **58/58** at 1280 and 390 px, dark and light, signed out and as a
moderator — 0 CSP violations, 0 console errors, no horizontal overflow; an `<img onerror>` body, a
`<script>` post and a `<b>` report reason all rendered as text with no element created; badges, the held
flag, the Report / Delete placement, the moderator queue, the live rules, a post appended once across the
next poll. The three admin pages were checked **statically only** (their scripts parse, the test rules
above); they have not been opened in a browser.

Games `npm test`: **803 → 815 passed, 0 failed**. Pool `npm test`: **2301 → 2322**, exit 0.

**Owed on the VPS** (with checkpoint A, in `preview` with `chat_enabled` on): post / hold / report /
approve / delete from the admin panel and see it leave an open /play/ page within one poll; mute and ban
(sessions signed out); appoint a moderator, act from /play/ with a password sign-in, and confirm the IP
sign-in is refused; the three admin pages through the real proxy, including every step-up dialog.

#### Part 10: PvP correspondence chess + the "add a game" checklist

Built on Parts 1–9 with nothing run on a box (2026-09-28). Contract: design §19.6 + §19.8 + §19.9 + D20;
deltas: §19.15 *Part 10*. **No pool backend code** — match void is one more `/internal/admin/*` write,
step-up by the proxy's fail-closed rule; `FAST_WRITES` is unchanged. **No schema change** — PvP uses the
v1 columns (`target`, `draw_offer_by`, `rated`, `idx_matches_pair` …) Part 0 already put in §19.4.

| File | What |
|---|---|
| `play/server/lib/matches.js` | PvP create (seek = no target, challenge = a full target address) with the open / active caps; `accept` / `decline` / `cancel`; `draw` (offer / accept / decline — an offer meeting the other side's accepts, a move clears one); `abort` (ply < 2, both refunded); a PvP resign at ply < 2 becomes an abort; the 72 h seek/challenge expiry on `turn_deadline` (lazy + the sweep, now per state); the rated rule at settle + Elo; `GET /play/api/lobby`, `GET /play/api/matches/turns`; `actions` / `open_seat` / `invited` / `target_label` / `rated` / `draw_offer_by` / `expires_at` on every view; admin `POST matches/:id/void` |
| `play/server/lib/ratings.js` (NEW) | Elo K = 24 from 1200, integer and zero-sum; `apply` at settle, `recompute(game)` after a void |
| `play/server/lib/settings.js` | `pvp_play_cost` 1, `pvp_active_max` 10, `pvp_open_max` 5, `pair_rated_daily` 3 |
| `play/server/lib/app.js`, `http.js`, `moderation.js` | admin built before matches (void registers through it); `/play/api/rules` gains the PvP numbers; ten error messages; the admin player view's match list carries `rated` + `ply` |
| `play/shell/js/play-lobby.js` (NEW) | the G-08 "Play a person" panel: post a seek or challenge (game / colour / time per move from the manifest), open seeks, challenges for you, Accept / Decline / Cancel as two-click buttons; talks to the shell only through `play:open` / `play:changed` / `play:me` / `play:turns` |
| `play/shell/js/play-shell.js` | board buttons shown from the view's `actions`; open-seek / challenge / draw-offer status lines; the board poll (5 s, visible, opponent to move, `since_ply`) and the turns poll (15 s / 60 s) with the "N to move" badge; seek / challenge rows in My games; a Game picker on the bot form (hidden while one game offers bot play) |
| `play/shell/js/play-boards.js` | rating, PvP wins and PvP points boards per game with a `pvp` mode |
| `play/shell/js/frame-host.js` | an empty seat's label is "Open seat" |
| `play/shell/index.html`, `css/play.css` | the G-08 panel, eight board buttons, the My games badge, the PvP lines in the fold, the script tag |
| `back-end-pool/admin-panel/games-players.html` | a Void button per voidable match (step-up, confirm with reason), the rated flag |
| `back-end-pool/admin-panel/games.html` | a "Games between players (PvP)" group for the four new settings |
| `play/README.md` | the layout table brought up to date + the **"Add a game" checklist** |
| tests | NEW `test-pvp.js` (90); `test-shell.js` +13 (the lobby panel, its API paths, body-only target, no polling, the event contract, every action button, both polls, since_ply, the PvP boards); `test-matches.js` one check replaced (PvP is no longer refused) |

**The void, for an operator** (Games → Players → look the address up → Matches → *Void*): an active game
ends without a result and every seat gets its play back; an open seek or challenge closes and its creator
gets the play back; a finished game keeps its result on record but loses the points it paid (taken back
with `admin_void` rows, never below 0), leaves `results_daily`, and — if it was rated — every rating in
that game is recomputed without it. Event rewards already paid are not clawed back (as a `done` event's
cancel). Aborted / declined / expired / void matches answer 409 `not_voidable`.

**Verified locally:** a one-shot headless-Edge probe (127.0.0.1 stub server, the real shell and chess
frame under the real `/play/` and frame CSP headers, stubbed `/play/api/`, the server closed and Edge
gone after — the script lived in the session scratchpad only): signed in on an active PvP game with the
opponent's draw offer and on the player's own open seek — 0 page console errors, 0 CSP violations; the
board showed exactly Accept draw / Decline draw / Abort, then exactly Cancel seek; the "1 to move" badge,
the live PvP cost and pair cap in the fold and the form hint; an `<img onerror>` seek name rendered as
text with no element created; at 390 px (the iframe probe) every panel fits with no horizontal overflow.
Dark theme only; the admin pages were checked **statically only** (their scripts parse, the pool tests).

Games `npm test`: **815 → 918 passed, 0 failed** (6 → 7 suites). Pool `npm test`: **2322/2322**, exit 0 (no pool test added: the void is a proxied step-up write the existing `test-admin-panel.js` rules already cover).

**Owed on the VPS** (Part 13): one PvP correspondence game between two addresses (one IP-proof, one
password-proof) with a draw offer, a decline and an accept; a timeout; a seek that expires and refunds;
a challenge declined; the pair cap on a 4th game the same UTC day; the rating board after 5 rated games;
a void of a finished rated game from the admin panel (step-up dialog), with the points and the rating
seen to change back.

#### Part 11: independent review — the fixes as built (2026-09-28)

The review record (all 20 threat notes, the six probes, the open items) is design §19.15 *Part 11
review*; the audit roll-up rows are P11-1 … P11-5 in `script07_security_audit.md`. What changed in code:

| File | Change | Test |
|---|---|---|
| `back-end-pool/lib/games-link.js` | Global caps, keyed on nothing a caller controls: verify-proof ≤ `VERIFY_INFLIGHT_MAX` 4 in flight and `VERIFY_PER_MIN` 120 / min; activity `ACTIVITY_PER_5MIN` 60 per 5 min. Checked after validation; over → 429 `busy`, logged at most once a minute. **Pool backend code — it ships with the pool deploy (one pool restart), which Part 2's code needs anyway.** | `test-games-link.js` [14], 8 checks |
| `play/server/lib/matches.js` | `settle` writes no `results_daily` row for a free match (cost 0); admin void takes counts off only for a match `settle` counted | `test-matches.js` (d) +1, `test-pvp.js` (e) +2 |
| `play/server/lib/plays.js` | Comment only: a settings change re-rates the current UTC day | — |
| `play/shell/index.html` | Sign-in card: the "someone else can sign in as you" hint | `test-shell.js` unchanged, passes |
| `scripts/07_grin_mining_public_pool.sh` | The `B) Backup & Restore` menu row re-aligned | `bash -n` |

Games `npm test`: **918 → 921 passed, 0 failed**. Pool `npm test`: **2322 → 2330**, exit 0.

**For the operator:** when the pool answers `busy` (429), a games login shows "the pool is
unreachable" and the plays sync retries on its next tick — an honest games service never reaches the caps,
so a `[games-link] … over its global cap` line in the pool log means the games process is misbehaving or
compromised: stop it (`P → 4`) and read its log. Two decisions are yours (design §19.15 *Part 11 review*
O1, O2): opting the account page out of analytics / custom HTML / code ads, and accepting D21's
moderator-inheritance limit.


#### Part 12: approved nicknames (2026-09-28)

The contract is design §19.16; the departures from the plan are §19.15 *Part 12*. No pool backend code:
the three admin writes are step-up by the existing `FAST_WRITES` rule, so the pool's admin proxy carries
them unchanged — this part ships with the games deploy (`P → 2`) plus the pool's static admin files.

| File | Change | Test |
|---|---|---|
| `play/server/lib/names.js` | NEW. The name rule, the request lifecycle, `label()` (the ONE public name: the mask or `Nick (mask)`), `meView` for `/me`, the admin queue + flags, `removeLiveOf` for a ban, the 180-day purge | `test-names.js` (NEW, 78) |
| `play/server/lib/db.js` | Migration **v3**: `nicknames` + three partial unique indexes + three indexes | `test-skeleton.js` (v1 → v3, v2 → v3, §19.4 == schema) |
| `play/server/lib/settings.js` | `nicknames_enabled` (bool, default on) | `test-names.js` (b, d) |
| `play/server/lib/auth.js` | `chatStatus(s, { ignoreChatSwitch })`; `/me` carries `nickname` | `test-names.js` (b) |
| `play/server/lib/{chat,leaderboard,events,matches}.js` | Every public name through `names.label` (fallback: the mask, so a module built without names behaves as before) | `test-names.js` (d, e) |
| `play/server/lib/moderation.js` | A ban removes the live nickname and refuses a pending one; the Players view carries `nickname` | `test-names.js` (c, d) |
| `play/server/lib/app.js` | Builds `names` before the modules that display names; routes; the hourly `nickname_purge` job | all suites |
| `play/shell/index.html`, `css/play.css`, NEW `js/play-names.js` | The Nickname fold in the account strip (state, "others see you as", pending / refused lines, the request form, withdraw / remove); the "How plays are earned" line on names | `test-shell.js` +9 |
| `back-end-pool/admin-panel/games-names.html` | NEW. Games → Nicknames: queue / Live / Rejected, approve / reject / remove (step-up), flags, text-only rendering | `test-admin-panel.js` [15] |
| `admin-panel/admin-shell.js`, `games.html`, `games-players.html`, `games-admin.js` | NAV entry; the page link + the switch's label; the nickname line on a player; three error texts | `test-admin-panel.js` [15] |

Games `npm test`: **921 → 1010 passed, 0 failed** (8 suites). Pool `npm test`: **2330 → 2341**, exit 0.
Mutation-checked: showing a nickname without its mask, removing the gate, and removing the approve-time
"taken" check each turn `test-names.js` red (the last is still refused by the unique index, as a 500).
**Not done:** no browser probe of the fold or of `games-names.html` (static checks only); nothing on a VPS.

**For the operator:**
- Nothing to install: the next `9) Deploy new code` (which ends with the games deploy) migrates the games DB
  to v3 on the service's restart. Nicknames are **on** by default; switch them off under Games → Overview &
  settings → Nicknames.
- Requests arrive in **Games → Nicknames**. Approve, reject (the reason is shown to the player on /play/)
  or remove; each asks for your admin password. A red "Same as a live name" flag means approve will be
  refused. A ban also ends the address's nickname; an unban does not bring it back.
- What players see: `Night Shift (grin1abcd…wxyz)` — the nickname never appears without the mask.

---

## 11. Ports

The reference §5 and §8 point at. Mainnet and testnet are separated by PORT, not by box — every
row below has two values.

**Pool box (`singlebox` / `hub`)**

| Port | Mainnet | Testnet | Bind | What |
|---|---|---|---|---|
| Public stratum | 3333 | 13333 | `0.0.0.0` | miners. Raw stratum only — a PROXY-v2 header is never accepted here |
| Central API | 8080 | 8090 | `127.0.0.1` | Express backend; reached from outside only through the nginx vhost |
| HTTPS | 443 | 443 | `0.0.0.0` | nginx (static site + `/api/*` proxy) |
| Node built-in stratum (upstream) | 3416 | 13416 | `127.0.0.1` | grin's own `stratum_server_addr` default — the toolkit does **not** move it |
| Node API (foreign/owner) | 3413 | 13413 | `127.0.0.1` | wallet → node |
| Wallet combined listener | 3420 | 13420 | `127.0.0.1` | `owner_api` + `include_foreign`; ECDH auto-unlock. `:3415`/`:13415` is retired (kept only as `api_listen_port` in `grin-wallet.toml`) |
| Region stratum listeners | 3391, 3392, … | 13391, 13392, … | `region_listen_host` (the wg server IP) | one per regional gateway; region is stamped from the listener |
| WireGuard | 51820/udp (`wg-grinpool`) | 51821/udp (`wg-grinpool-tn`) | `0.0.0.0` | only when multi-region is enabled |

Tunnel nets: `10.66.66.0/24` (mainnet) / `10.66.67.0/24` (testnet); hub `.1`, gateways `.2`, `.3`, …

**Gateway box**

| Port | Value | Bind | What |
|---|---|---|---|
| Public stratum | 3333 (`public_stratum_port`) | `0.0.0.0` | miners; HAProxy `mode tcp` + `send-proxy-v2`, stick-table conn-rate limit |
| WireGuard | ephemeral → the hub's 51820 (mainnet) / 51821 (testnet) udp | — | local iface is always `wg-grinpool` |
| Latency probe (optional) | 443/tcp | `0.0.0.0` (IPv4) | only after `6) Latency probe` → enable: `grin-gateway-probe`, a separate HAProxy answering `GET /ping` with 204 and 404 to anything else (§8.7) |
| certbot HTTP-01 (optional) | 80/tcp | `0.0.0.0` | opened in the firewall with the probe, but **bound only for the seconds of an issue/renewal** (certbot standalone); nothing listens otherwise |

A gateway box runs **nothing else** — no node, no wallet, no DB, no Node.js. Its only HTTP
listener is the optional latency probe above, which has no backend and serves no data.

The hub's `/ping` (204, for the same measurement) rides its existing nginx `:443`.

**One mining role per box.** A brain and a gateway both bind :3333, so `pool_mode_conflict_check`
refuses to install one where the other (or a legacy satellite) already exists. Mainnet and testnet
*pools* can share a box; solo mining cannot share with either.
