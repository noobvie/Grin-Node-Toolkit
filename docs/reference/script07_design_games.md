# Script 07 — Games Platform `/play/` (Design)

> **Covers code as of:** 2026-10-04 for §19.15 *R2 review* and the §19.14 R2 row (the C5–C7 working tree as R2 read it — games `play/server/**`, `play/shell/**`, pool `public_html/**`, `back-end-pool/**`, `07_lib_pool_games.sh` — plus R2's fix in games `lib/guests.js` + `lib/ratelimit.js`; uncommitted, not VPS-tested) · 2026-10-04 for §19.15 *Part C7*, the §19.14 C7 row and the §19.17.7 as-built pointer (the C7 working tree: games `play/shell/**` — NEW `play-chat-core.js`, `chat-bubble.js`, `chat-bubble.css` — and `lib/app.js` `rules.mode`; pool `public_html/js/branding.js`, NEW `public_html/js/cms-frame.js`, `page.html`, `post.html`; uncommitted, not VPS-tested) · 2026-10-04 for §19.15 *Part C6*, the §19.14 C6 row and the §19.17.3 PoW note (the C6 working tree: `play/shell/**` — NEW `play-guest.js`, `play-pow.js`; three sentences in games `lib/http.js`; one label in the pool admin `games.html`; uncommitted, not VPS-tested) · 2026-10-04 for §19.15 *Part C5*, the §19.14 C5 row and the §19.4 v5 SQL (the C5 working tree: games `lib/guests.js`, `lib/tickets.js`, schema v5 and the hooks named in §19.15 *Part C5*; uncommitted, not VPS-tested) · 2026-10-04 for §19.15 *R1 review*, the §19.14 R1 row and the §19.17.5 pool-name pointer (the C1–C4 working tree as R1 read it, plus R1's two fixes to `name-rule.js` (both copies) and the shared fixture; uncommitted, not VPS-tested) · 2026-10-04 for §19.15 *Part C4*, the §19.14 C4 row, the §19.17.6 pointer, the §18 C4 note and the §18.11 C4 pointer (donor names auto-checked — the files named in *Part C4*; uncommitted, not VPS-tested) · 2026-10-04 for §19.15 *Part C3*, the §19.14 C3 row, the §19.4 v4 block and the two §19.17.5 pointers (names v2 — the files named in *Part C3*; uncommitted, not VPS-tested) · 2026-10-04 for §19.15 *Part C2*, the §19.14 C2 row and the two §19.3 default cells + health shape (launch state, Community header group, defaults on — the files named in *Part C2*; uncommitted, not VPS-tested) · 2026-10-04 for §19.15 *Part C1* and the §19.14 C1 row (Option B as built: `public_html/js/branding.js`, `public_html/js/ads.js`, a `public-shell.js` comment, `back-end-pool/lib/ads.js`, `lib/pool-settings.js`, the `index.js` step-up list, `admin-panel/ads.html`, `admin-panel/settings-analytics.html` — uncommitted, not VPS-tested; §19.17's text is unchanged by it) · 2026-10-03 for §19.17 and the edits it made elsewhere in §19 (v2 open community, Part C0 — a DESIGN written BEFORE any code, against the uncommitted games working tree as Part 12 left it and the pool files named in the plan's C1–C7 prompts; the code facts it leans on were read, not run: `branding.js` `applyAnalytics`/`cloneScript`/`CREDENTIAL_PAGES`, `ads.js`'s `code` type, `public-shell.js` NAV, `donor-names.js` `RESERVED` + the substring-matched `STARTER_BLOCKLIST`, `pool-settings.js` games defaults, `play/server/lib/settings.js`. Nothing in §19.17 exists in code yet) · 2026-09-28 for §19.16, §19.15 *Part 12*, the §19.4 v3 block, D19's amendment, the §19.10 name line, the §19.11 `games-names.html` row, §19.13 #21 and the §19.14 Part 12 row (approved nicknames: `play/server/lib/names.js` + its wiring, `play/shell/js/play-names.js`, `admin-panel/games-names.html`, written against the uncommitted working tree) · 2026-09-28 for §19.15 *Part 11 review*, the §19.14 Part 11 row, the §19.6 settings paragraph and the §19.8 free-match sentence (the whole games platform as reviewed — `play/**`, `back-end-pool/lib/games-link.js`, `scripts/lib/07_lib_pool_games.sh` + hooks — plus the review's own fixes, written against the uncommitted working tree) · 2026-09-28 for the §19.6 / §19.8 / §19.11 Part 10 edits, the §19.14 Part 10 row and §19.15 *Part 10* (PvP in `play/server/lib/{matches,ratings}.js`, `play/shell/js/play-lobby.js` + the board in `play-shell.js`, `admin-panel/games{,-players}.html`, written against the uncommitted working tree) · 2026-09-28 for D21, the §19.4 v2 tables, the §19.10 report / change-feed / moderator paragraphs, the §19.11 edits, the §19.14 Part 8–9 rows and §19.15 *Part 8* + *Part 9* (the chat + moderation code in `play/server/lib/`, the G-07 panel in `play/shell/`, `admin-panel/games{,-chat,-players}.html` + `games-admin.js`, written against the uncommitted working tree) · 2026-09-28 for the §19.14 Part 7 row, §19.15 *Part 7*, §19.9's `reward_json` line, §19.11's `games-events.html` row and the §19 heading (leaderboards, events and the admin guard in `play/server/lib/`, the G-06 panel in `play/shell/`, `admin-panel/games-events.html` + the Games NAV group, written against the uncommitted working tree) · 2026-09-27 for the §19.14 Part 6 row, §19.15 *Part 6* and §19 heading (the shell + chess frame in `play/shell/` + `play/games/chess/frame/`, `public_html/js/public-shell.js` and `_pgs_stage_trees`, written against the uncommitted working tree) · 2026-09-27 for the §19.14 Part 5 row, §19.6's points note and §19.15 *Part 5* (registry, matches and chess in `play/server/lib/` + `play/games/chess/`, written against the uncommitted working tree) · 2026-09-27 for the §19.14 Part 4 + checkpoint A rows and §19.15 *Part 4* (login, sessions, activity sync and ledger in `play/server/lib/`, written against the uncommitted working tree) · 2026-09-27 for §19.12's *As built* note, the §19.14 Part 3 row and §19.15 *Part 3* (the operator side, `scripts/lib/07_lib_pool_games.sh` + its hooks in the pool, backup and migrate scripts, written against the uncommitted working tree) · 2026-09-27 for §19's heading, the §19.3 common-rules bullet + settings note, the §19.11 fast-write table, the §19.14 Part 2 row and §19.15 *Part 2* (the pool link, `back-end-pool/lib/games-link.js` + its mount lines, written against the uncommitted working tree) · 2026-09-27 for the §19.14 Part 1 row and §19.15 *Part 1* (the games service skeleton in `play/server/`, written against the uncommitted working tree) · design only, 2026-09-27, for the rest of §19 (games platform — Parts 5–13 have no code yet; the pool facts it cites were read in the working tree that day: `GRIN_ADDR_RE`, `secureAdmin`/`freshAdmin`, `maskAddr`, `verifyOwnerProof`'s return contract, `hashrate_history` + `idx_hashrate_time`, `HashrateTracker.recordHashrates`, `RESERVED_ADDRESSES`)
> **Last verified:** **2026-10-04, PARTIAL — by the R2 review session (which built none of C5–C7)**: §19.17.3/.4/.7, threat notes #22 and #26–#30 and the §19.15 *Part C5*–*C7* departures named in §19.15 *R2 review* were read against the working tree and probed (a harness against the real games app, headless Edge); the rest of §19 was not re-checked · **2026-10-04, PARTIAL — §19.15 *Part C7* only, by the C7 builder against its own code (tests + a headless-Edge probe; not an independent check)** · **2026-10-04, PARTIAL — §19.15 *Part C6* only, by the C6 builder against its own code (tests + a headless-Edge probe; not an independent check)** · **2026-10-04, PARTIAL — by the R1 review session (which built none of C1–C4)**: §19.17.1/.2/.5/.6/.8 and threat notes #22–#25 read against the working tree; of the §19.15 *Part C1–C4* notes, the claims named in §19.15 *R1 review* were checked in code (C1 items 1–8 except the per-file innerHTML counts, C2 items 1, 2, 5–8, 11, 13, C3 items 1–3, 5, 6, 8–10, C4 items 1, 2, 4–6, 8, 9, 15) and the rest — the test counts, the CSP inventory, the v4 data step, the admin-page UI — were NOT re-verified; the nav matrix rendered in headless Edge; both suites re-run (pool 2795, games 1114) · §19.15 *Part C4*: never verified (written with the code it describes; R1 checks it) · §19.15 *Part C3*: never verified (written with the code it describes; R1 checks it — the §19.4 v4 block alone is machine-checked: `test-skeleton.js` executes it against the migration) · §19.15 *Part C2*: never verified (written with the code it describes; R1 checks it) · §19.15 *Part C1*: never verified (written with the code it describes; R1 checks it — a passing suite verifies the code, not this text) · §19.17: never verified (a design for code that does not exist yet; R1 and R2 check the builds against it) · 2026-09-28, PARTIAL — **§19.16, §19.15 *Part 12*, the §19.4 v3 block and the Part 12 line edits only, by the Part 12 build session**: each statement read against `play/server/lib/{names,auth,chat,leaderboard,events,matches,moderation,app,db,settings}.js`, `play/shell/js/play-names.js` and `admin-panel/games-names.html` as written that session; §19.4 is test-bound (`test-skeleton.js`); games `npm test` 1010/1010, pool 2341/2341; no browser probe, nothing run on a VPS · 2026-09-28, PARTIAL — **§19.13's threat notes and §19.15 *Part 11 review* only, by the Part 11 review session** (a session that built none of Parts 1–10): each answer read against the code it cites; games `npm test` 921/921, pool 2330/2330; nothing run on a VPS. The rest of §19 was NOT re-verified line by line · 2026-09-28, PARTIAL — **§19.14's Part 10 row, §19.15 *Part 10* and the §19.6 / §19.8 / §19.11 edits only, by the Part 10 build session**: each delta read against `play/server/lib/{matches,ratings,settings}.js`, `play/shell/js/{play-lobby,play-shell,play-boards}.js` and `games-players.html` as written that session; games `npm test` 918/918 (NEW `test-pvp.js` 90), pool `npm test` 2322/2322, a headless-Edge probe of the PvP board + lobby (dark only) · Earlier: 2026-09-28, PARTIAL — **D21, §19.4's v2 block, the §19.10 / §19.11 edits, §19.14's Part 8–9 rows and §19.15 *Part 8* + *Part 9* only, by the Part 8–9 build session**: each delta read against `play/server/lib/{chat,moderation,auth,settings,db,app}.js`, `play/shell/js/play-chat.js` and the three admin pages as written that session; §19.4's block is test-bound (games `npm test` 815/815, NEW `test-chat.js` 171), pool `npm test` 2322/2322, a headless-Edge probe 58/58 · Earlier: 2026-09-28, PARTIAL — **§19.14's Part 7 row, §19.15 *Part 7* and the §19.9 / §19.11 line edits only, by the Part 7 build session**: each delta read against `play/server/lib/{leaderboard,events,admin,badges}.js`, `lib/events/*`, `play/shell/js/play-boards.js` and `games-events.html` as written that session; games `npm test` 630/630 (NEW `test-events.js` 101), pool `npm test` 2301/2301 (`test-admin-panel.js` [13]), a one-shot headless-Edge probe 58/58 of the /play/ panel under the real shell CSP; `games-events.html` not opened in a browser; nothing run on a VPS. Before that: 2026-09-27, PARTIAL — **§19.14's Part 6 row and §19.15 *Part 6* only, by the Part 6 build session**: each delta read against `play/shell/**`, `play/games/chess/frame/**`, `public-shell.js` and `_pgs_stage_trees` as written that session; games `npm test` 519/519 (NEW `test-shell.js` 68, five mutations each turning it red), pool `npm test` 2290/2290, a one-shot headless-Edge probe 48/48 against the staged tree with the real nginx headers; nothing run on a VPS. The same session also REPAIRED this file: the Part 5 session's write of §19.15 *Part 5* #1 had expanded a literal `$` + backtick as a perl pre-match, pasting a second copy of lines 1–4377 mid-sentence (9 314 lines); the duplicate was checked byte-identical to the file's own prefix before it was cut, so nothing unique was lost. Before that: 2026-09-27, PARTIAL — **§19.14's Part 5 row and §19.15 *Part 5* only, by the Part 5 build session**: each delta read against `play/server/lib/{registry,matches,settings,app,http}.js` and `play/games/chess/` as written that session; games `npm test` 451/451 on Windows (NEW `test-matches.js` 133, with perft exact on five reference positions); nothing run on a VPS. Before that: 2026-09-27, PARTIAL — **§19.14's Part 4 row and §19.15 *Part 4* only, by the Part 4 build session**: each delta read against `play/server/lib/{pool-link,ratelimit,ledger,plays,sessions,auth,mode,settings}.js` and `app.js` as written that session; games `npm test` 318/318 on Windows, with four mutations each turning `test-auth.js` red; nothing run on a VPS. Before that: 2026-09-27, PARTIAL — **§19.12's *As built* note, §19.14's Part 3 row and §19.15 *Part 3* only, by the Part 3 build session**: each delta was read in `07_lib_pool_games.sh` and the hooks as written that session; `bash -n` on the pool script and the three touched libs; the nginx snippet heredoc rendered with the mainnet constants and read; the deploy staging run once against the checkout. Nothing ran on a VPS. Same day, PARTIAL — **§19.3's common-rules bullet and settings note, §19.11's fast-write table, §19.14's Part 2 row and §19.15 *Part 2* only, by the Part 2 build session**: each statement was checked against `lib/games-link.js`, `lib/pool-settings.js`, `lib/config.js` and the `index.js` mount lines as written that session; the activity plan was run with `EXPLAIN QUERY PLAN` on the real schema, with and without the `INDEXED BY` pin; pool `npm test` exit 0, 2282 passed / 0 failed. Nothing was run against a live pool or on a VPS. Same day, PARTIAL — **§19.14's Part 1 row and §19.15 *Part 1* only, by the Part 1 build session**: each delta was read in the code it describes; the games `npm test` passed 155/155 on Windows (the 0600 mode and SIGTERM checks are POSIX-only and were skipped); §19.4's SQL block was compared with the v1 migration mechanically by that suite (35 objects), and that comparison was mutation-checked to fail on a changed default, CHECK or partial index. Nothing was run on a VPS. Same day, PARTIAL — **§15.5's "Response binding" bullet only, by the session that made the binding fix**: both finalize paths read in `lib/withdrawal-scheduler.js` after the edit; `npm test` exit 0 (impl §10.10 *Slatepack finalize binding*)
> **Product code last changed:** 2026-10-12 (`4288b87`: the games DB in the hub move and backup — `07_lib_pool_games.sh`; impl §10.13 *Backup / restore*) · 2026-10-11 (`dc3173a`: chat-bubble miner sign-in inputs — `play/shell/js/chat-bubble.js` + `test-shell.js`) · 2026-10-04 (§19.17 R2 review: games `lib/guests.js` — the per-name budget reserved before the scrypt await, the current-password check single-flight — and `lib/ratelimit.js` `refund`; before it, §19.17 Part C7: games `play/shell/**` (the chat core, the bubble, the shell hints) + `lib/app.js`; pool `public_html/js/branding.js`, `js/cms-frame.js` (new), `page.html`, `post.html`; before it, Part C6: games `play/shell/**` + `lib/http.js` messages + the pool admin `games.html` PoW label; before it, Part C5: games `lib/guests.js` + `lib/tickets.js` (new), `lib/db.js` (v5), `auth`, `sessions`, `chat`, `names`, `matches`, `moderation`, `leaderboard`, `events` + two kinds, `plays`, `pool-link`, `mask`, `settings`, `ledger`, `app`; admin `games-admin.js`, `games.html`, `games-players.html`, `games-chat.html`, `games-names.html`; `scripts/lib/07_lib_pool_games.sh`; uncommitted, not VPS-tested) · 2026-10-04 (§19.17 R1 review: `poolNameEntry` and two EXCEPTIONS in pool `lib/name-rule.js` + the games copy (identical code) + the shared fixture; uncommitted, not VPS-tested) · 2026-10-04 (§19.17 Part C4: pool `lib/name-rule.js` + the games copy (identical code) + the shared fixture, `lib/donor-profiles.js`, `lib/donor-names.js`, `lib/pool-settings.js`, `lib/db.js` (`banned_donor_names`), `index.js`, admin `donors.html` / `settings-names.html` / `index.html` / `admin-shell.js`, public `donate.html` / `account-settings.html`; uncommitted, not VPS-tested) · 2026-10-04 (§19.17 Part C3: games NEW `lib/name-rule.js`, `lib/names.js`, `lib/db.js` (v4), `lib/settings.js`, `lib/pool-link.js`, `lib/mode.js`, `lib/app.js`, `lib/moderation.js`, NEW `scripts/fixtures/name-rule.json`, `scripts/test-names.js`, `test-skeleton.js`, `test-shell.js`, `shell/index.html`, `shell/js/play-names.js`, `play-chat.js`; pool NEW `lib/name-rule.js`, `lib/pool-settings.js`, `lib/games-link.js`, `index.js` step-up list, NEW `admin-panel/settings-names.html`, `admin-shell.js`, `games-names.html`, `games-admin.js`, `games.html`, `games-players.html`, NEW `scripts/test-name-rule.js`, `test-games-link.js`, `test-admin-panel.js`, `package.json`) · 2026-10-04 (§19.17 Part C2: games `lib/mode.js`, `lib/app.js`, `lib/db.js`, NEW `scripts/test-launch.js`, `test-skeleton.js`; pool `lib/games-link.js`, `lib/pool-settings.js`, `public_html/js/public-shell.js`, `branding.js`, `admin-panel/games.html`, `settings-games.html`, `settings-common.js`, `scripts/test-games-link.js`, `test-public-leakage.js`; `scripts/lib/07_lib_pool_games.sh`; uncommitted, not VPS-tested) · 2026-10-04 (§19.17 Part C1, Option B: the eight files named above, plus NEW `scripts/test-operator-code-sinks.js`, `test-branding-sinks.js`, `test-admin-guards.js`, `test-admin-panel.js`, `package.json`; uncommitted, not VPS-tested) · 2026-09-28 (§19 Part 12 approved nicknames: NEW `play/server/lib/names.js` + `scripts/test-names.js`, migration v3 in `lib/db.js`, `nicknames_enabled` in `lib/settings.js`, `chatStatus` option + `/me` nickname in `auth.js`, `names.label` in `chat.js` / `leaderboard.js` / `events.js` / `matches.js`, ban ends the nickname in `moderation.js`, wiring + purge job in `app.js`; NEW `play/shell/js/play-names.js` + the Nickname fold; pool NEW `admin-panel/games-names.html`, the NAV entry, `games.html` / `games-players.html` / `games-admin.js` lines, `test-admin-panel.js` [15]; no pool backend code; **uncommitted, not VPS-tested**) · 2026-09-28 (§19 Part 11 review fixes: a free match writes no `results_daily` row + the matching void guard in `play/server/lib/matches.js`; global caps on the internal routes in `back-end-pool/lib/games-link.js`; the sign-in card's "someone else can sign in as you" line; the `plays.js` settings comment; the pool menu's B row; uncommitted, not VPS-tested) · 2026-09-28 (§19 Part 10: PvP seeks / challenges / draw / abort / timeout / rated pair cap / void in `play/server/lib/matches.js`, NEW `lib/ratings.js` + `scripts/test-pvp.js`, four PvP settings; NEW `play/shell/js/play-lobby.js` + the G-08 panel, PvP board buttons + polls, PvP boards; pool `games-players.html` void + `games.html` PvP group; no pool backend code; **uncommitted, not VPS-tested**) · earlier 2026-09-28 (§19 Parts 8–9: NEW `play/server/lib/{chat,moderation}.js` + `scripts/test-chat.js`, migration v2 in `lib/db.js`, the mining gate + `modStatus` in `auth.js`, chat settings, `/play/api/rules`; NEW `play/shell/js/play-chat.js` + the G-07 panel, `play:me` in `play-shell.js`; pool NEW `admin-panel/games.html`, `games-chat.html`, `games-players.html`, `games-admin.js` + the Games NAV group; no pool backend code) · earlier 2026-09-28 (§19 Part 7: NEW `play/server/lib/{leaderboard,events,admin,badges}.js` + `lib/events/{index,_rules,game_results,mining_minutes,active_days}.js` + `scripts/test-events.js`; `app.js` wiring + two jobs, a route `guard` in `http.js`, `checkSecret` in `pool-link.js`, `badges` on `/me`; NEW `play/shell/js/play-boards.js` + the G-06 panel; pool NEW `admin-panel/games-events.html` + the Games NAV group, `test-admin-panel.js` +11; no pool backend code; **uncommitted, not VPS-tested**) · Same day as the next entry: 2026-09-27 (§19 Part 6: NEW `play/shell/**` (page, `play-api.js`, `frame-host.js`, `play-shell.js`, `play.css`) + `play/games/chess/frame/**` + games `scripts/test-shell.js`; pool `public_html/js/public-shell.js` site-absolute hrefs + no ads on exempt pages, `test-games-link.js` +4; `07_lib_pool_games.sh` stamps `__GRIN_PLAY_VERSION__`; **uncommitted, not VPS-tested**) · Same day (§19 Part 5: NEW `play/server/lib/{registry,matches}.js`, `play/games/chess/{manifest.json,rules.js}` and `scripts/test-matches.js`; wiring in `lib/app.js`, two settings keys, ten message codes in `lib/http.js`; no pool code; **uncommitted, not VPS-tested**) · Same day (§19 Part 4: NEW `play/server/lib/{pool-link,ratelimit,ledger,plays,sessions,auth,mode,settings,mask}.js` + `scripts/test-auth.js`, wiring in `lib/app.js` / `index.js`, `sameOriginOk` + error headers in `lib/http.js`; no pool code; **uncommitted, not VPS-tested**) · Same day (§19 Part 3: the operator side — NEW `scripts/lib/07_lib_pool_games.sh` (menu `P`), the vhost's `/internal/` 404 + games glob include, games deploy in `9)`, games VACUUM in `C)`, cleanup group 1b/1c in the pool script; the games DB snapshot + separate restore in `07_lib_pool_backup.sh` / `07_lib_pool_migrate.sh`; impl §10.13 *Operator side*; **uncommitted, not VPS-tested**) · Same day (§19 Part 2: the pool link — NEW `back-end-pool/lib/games-link.js` (three `/internal/games/*` routes, the `/api/admin/games/*` proxy, the 60 s probe), the `games` settings section, `games_port` / `games_link_secret_file` config defaults, `index.js` mount lines + the `games` step-up section + the branding `games` flag, the hidden Play nav item, NEW `admin-panel/settings-games.html`, NEW `scripts/test-games-link.js`; impl §10.13; **uncommitted, not VPS-tested**) · Same day (§19 Part 1: the games service skeleton, NEW `web/07_mining_pool_public/play/` (`server/` + `README.md`), zero npm dependencies, nothing deploys it yet, the pool untouched; **uncommitted, not VPS-tested**)
> Prose last edited 2026-10-12 (moved out of `script07_design.md` whole; §19.14–19.15 → `script07_implementation.md`; dated status in headings → **Status:** lines. A re-section, not a verification) · 2026-10-04 (§19 v2 R2 review: §19.15 *R2 review*, the §19.14 R2 row, the §19 / §19.17 headings) · 2026-10-04 (§19 v2 Part C7: §19.15 *Part C7*, the §19.14 C7 row, the §19.17 heading, the §19.17.7 as-built pointer) · 2026-10-04 (§19 v2 Part C5: §19.15 *Part C5*, the §19.14 C5 row, the §19.4 v5 SQL + heading, the §19 / §19.17 headings) · 2026-10-04 (§19 v2 R1 review: §19.15 *R1 review*, the §19.14 R1 row, the §19 / §19.17 headings, the §19.17.5 pool-name pointer) · 2026-10-04 (§19 v2 Part C4: §19.15 *Part C4*, the §19.14 C4 row, the §19 / §19.17 headings, the §19.17.6 pointer, the §18 note and the §18.11 pointer; before it, Part C3: §19.15 *Part C3*, the §19.14 C3 row, the §19.4 v4 SQL, §19.16's superseded note, §19.17.5's moderator route + schema-sketch pointers, the §19 and §19.17 headings) · 2026-10-04 (§19 v2 Part C2: §19.15 *Part C2*, the §19.14 C2 row + status note, the §19.3 health line + default cells, the §19 and §19.17 headings) · 2026-10-04 (§19 v2 Part C1: §19.15 *Part C1*, the §19.14 C1 row, the §19 and §19.17 headings) · 2026-10-03 (§19 v2 Part C0: NEW §19.17 — D22–D32, launch state, guest accounts, tickets, names v2, donor names, the chat bubble, the Community header group, settings; D8/D9/D10/D12/D19/D21 amended in place; the §19.3 defaults cells; §19.16 marked superseded; §19.13 #22–#30; §19.14 rows C0–C9/R1/R2 and Part 13 → C9; O1 closed by D22 in §19.15 *Part 11 review*; the §19 heading) · 2026-09-28 (§19 Part 11 review: §19 heading, §19.6 settings paragraph, §19.8 free-match sentence, §19.14 Part 11 row + closing line, §19.15 *Part 11 review*) · 2026-09-28 (§19 Part 10 built: §19 heading, §19.6 PvP cost, §19.8 resign/abort + rated scope + routes, §19.11 rows, §19.14 Part 10 row + closing line, §19.15 *Part 10*) · 2026-09-28 (§19 Parts 8–9 built: §19 heading, D21, §19.4 v2 tables, §19.10 report + change feed + moderators, §19.11 rows + FAST-list note, §19.14 Part 8–9 rows + closing line, §19.15 *Part 8* (15 deltas) and *Part 9* (10 deltas)) · 2026-09-28 (§19 Part 7 built: §19 heading, §19.9 `reward_json` line, §19.11 `games-events.html` row, §19.14 Part 7 row + closing line, §19.15 *Part 7* with 15 deltas) · 2026-09-27 (§19 Part 6 built: §19 heading, §19.14 Part 6 row + closing line, §19.15 *Part 6* with 14 deltas; the file de-duplicated, see *Last verified*) · Same day (§19 Part 5 built: §19 heading, §19.6 points note, §19.14 Part 5 row + closing line, §19.15 *Part 5* with 13 deltas) · Same day (§19 Part 4 built: §19 heading, §19.14 Part 4 + checkpoint A rows + closing line, §19.15 *Part 4* with 14 deltas) · Same day (§19 Part 3 built: §19 heading, §19.12 *As built* note, §19.14 Part 3 row + closing line, §19.15 *Part 3* with 13 deltas) · Same day (§19 Part 1 built: §19 heading, §19.14 Part 1 row + closing line, §19.15 *Part 1* with 12 deltas) · Same day (§19 added — games platform `/play/`: separate `grin-games` service + `grinium-games.db`, the pool link contract, chess vs bot then PvP correspondence, events, moderated chat; design only, NOT built; D18–D20 answered by the operator that day)

**Product:** the `/play/` games service — `web/07_mining_pool_public/play/` +
`scripts/lib/07_lib_pool_games.sh` — and its link into the public pool.
**Scope:** §19 of the pool design, moved here whole on 2026-10-12. Section numbers are unchanged,
so `design §19.x` citations elsewhere resolve here.

> **Companion docs:** [`script07_design.md`](script07_design.md) — the pool design this platform
> plugs into · [`script07_implementation.md`](script07_implementation.md) — as built, including
> the games build records (§19.14–§19.15) · [`script07_security_audit.md`](script07_security_audit.md).

---

## 19. Games platform (/play/) — games, events, chat

**Status:** v1 (games, events, chat, PvP, approved nicknames) built 2026-09-27/28 and independently reviewed 2026-09-28; v2 *open community* (§19.17) designed 2026-10-03, built 2026-10-04 and independently reviewed twice the same day. Nothing VPS-tested.

Operator discussion 2026-09-26; the three open questions (D18–D20) answered 2026-09-27. GRINIUM
runs **live on mainnet** with a small group of miners, and the operator wants something that makes
them a community: games, competitions **between addresses**, and a moderated public chat. One
constraint sits above every decision here: **nothing in this section may slow down, restart or
endanger mining.**

**This section is the contract the build is held to.** When a build finds this section wrong, it records the change in §19.15 and does not
diverge silently.

### 19.1 Decisions (operator, 2026-09-26/27 — FINAL unless a build finds a hard reason)

| # | Decision | Why |
|---|---|---|
| D1 | **Points and plays are worthless outside the games.** They are never GRIN, never transferable between addresses, never tradable, and there is no shop in v1. No games code path may write a pool money table, and D5 makes that structurally impossible. A future "spend points" feature may only buy things *inside* the games (cosmetics, themes) and must never convert, transfer or pay out. | Once a point can move between addresses or turn into GRIN it has a price. A price invites farming, Sybil addresses and support disputes. Worthless points keep every cheat below the effort line, so the fairness rules below only have to be *fair*, not bank-grade. |
| D2 | **A separate service**: `grin-games` (mainnet) / `grin-games-testnet`, OS user **`grinplay`**, **zero npm dependencies** (`node:http` + `node:sqlite`, Node ≥ 24, already on the box for the pool). It binds `127.0.0.1:8081` (mainnet) / `127.0.0.1:8091` (testnet); both ports were checked free in `scripts/` on 2026-09-26. | The pool's stratum server shares **one** Node process and **one** synchronous `DatabaseSync` connection with the API (`lib/db.js`, the `busy_timeout` comment). Any slow statement in that process stalls share submission for every miner, **whatever file it touches**. So a separate DB file is necessary but not enough; the games need a separate process. Zero dependencies means no lockfile, no `npm audit` and nothing to vendor. |
| D3 | **DB = `grinium-games.db`** in a DATA dir outside the code dir. Code is `/opt/grin/pubgames/<net>/`; data is `/opt/grin/pubgames-data/<net>/grinium-games.db`. Pragmas: WAL, `synchronous=NORMAL`, `busy_timeout=2000`, `foreign_keys=ON`; file mode 0600. | The code dir is `rsync --delete`d on every deploy. The pool learned this the hard way: `uploads/` was pruned on every deploy until it was excluded by name (the comment above `pool_deploy_code`). With the data outside the code dir, that trap cannot happen. |
| D4 | **Same domain, path `/play/`.** The static shell is served by nginx from `/var/www/grin-play` (testnet `/var/www/grin-play-testnet`), OUTSIDE the pool docroot. The API is at `/play/api/`, proxied to the games service. Move to a subdomain only if a game ever needs a third-party engine, WASM or a looser CSP. | One origin, one certificate and one nav. `pool_deploy_web` `rsync --delete`s `$POOL_WEB_DIR`, which would prune a `/play/` living inside it. Loosening the CSP on a shared origin would also weaken the admin panel's, which is why anything that needs it moves to its own host. |
| D5 | **The pool owns proofs and mining data. The games service never reads `pool.db`**, not even read-only. It reaches the pool only through THREE internal routes on the pool's own `127.0.0.1` listener (§19.3), and the pool reaches it through ONE admin proxy (D11). `grinplay` is not in the `grinpool` or `grinsecret` groups, so file permissions enforce this. | A second reader on `pool.db` holds WAL read snapshots that can stall checkpoints, and it would need the pool's file permissions, which open everything else too. One narrow route with a bounded query is something we can measure and cap. |
| D6 | **Internal-route auth = a shared link secret** in `/opt/grin/conf/grin_pubgames_link_<net>`, owner **`grinplay`**, group **`grinpool`**, mode **0440**. The games service reads it as owner; the pool reads it through its primary group. It travels as the header `X-Games-Link` and is compared with `crypto.timingSafeEqual`. Internal routes live **outside `/api/`** (nginx only proxies `/api/…` and a few exact files to the pool), **and** the vhost gains an explicit `location ^~ /internal/ { return 404; }`. | Two independent controls, because either one alone is one typo away from open. *Refined from the first sketch*, which had a new group `grinlink` joined by both users: a running process keeps the groups it started with, so that design cost the pool one restart after install. Owner + primary group needs no group change, so it needs **no pool restart**. The operator-side install verifies with `id grinpool` that `grinpool` is the pool unit's primary group. |
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
| D19 | **Names in v1 = the masked address only**: the pool's public mask, `index.js maskAddr`, 9 leading + 4 trailing characters. Approved nicknames are the *optional* §19.16: pre-moderated, games-owned, always shown with the masked suffix and never alone. | The public-list invariant (`maskAddr`'s comment: no public route emits a full address in a LIST) carries over unchanged. Nicknames need a review queue of their own, so they wait until the core platform has been reviewed. **Amended 2026-09-28:** the operator chose nicknames; built as §19.16 — pre-moderated, and composed on the server into the one public `name` as `Nick (grin1abcd…wxyz)`, so no response carries a nickname without its mask. **Amended 2026-10-03 (§19.17, D27):** pre-moderation is **replaced** by an automatic check — 3–20 of `A–Z a–z 0–9`, reserved words, one pool-owned blocked-word list, banned names, uniqueness on the matching form — and a passing name is **live at once**; the operator, and moderators for removal only, post-moderate. Miners still show `Nick (grin1abcd…wxyz)`; guests show `Nick · guest` or `Guest-XXXX`. §19.16 is kept as the history of the pre-moderated flow. |
| D20 | **The v1 game is CHESS, as one `match` game with two modes.** First **vs a built-in bot** (the operator's solo test path), then **player vs player between two addresses, correspondence pace**: hours to days per move, with the page polling while it is open. Live timed games come later. **No team games in v1.** Block Hunt and Grin 2048, the first sketch's defaults, are dropped from v1; either can come back later as a game folder once its kind is built. | Chess is turn-based and its rules are deterministic, so the server can validate every move and a forged move is impossible. **A bot game is a match with the bot in one seat, played move by move on the server**, not a client-side game replayed afterwards: with a deterministic bot running in the browser, a player could try lines and undo them before submitting, which is unlimited takebacks. Move-by-move also reuses one engine for both modes. The bot is small, deterministic and budgeted, and runs in the games process. Stockfish was rejected: it is GPL, needs WASM (a CSP loosening, see D4), and on the server it would burn CPU on the pool's box. Correspondence first because the community is small and two players are rarely online together; it also needs no push connection. **Accepted limit:** engine-assisted play cannot be detected. Points are worthless (D1), so this is recorded, not fought. |
| D21 | **Chat moderators are miner addresses the operator appoints** (added 2026-09-28 by the chat build, answering the operator's question "can I add a moderator to help me?"; **confirm at acceptance**). A moderator acts from /play/ with their own games session, never from the pool admin panel. They can delete or approve a chat message and mute its author for ≤ 24 h. They cannot act on operator messages or on other moderators, and have no ban, purge, word list, settings, points, events or full addresses. Acting needs a chat-capable session and, by default (`mod_requires_password`), one opened with the rig **password**. Every action is a `mod_actions` row as `mod:<address>`. A ban ends the appointment; removal takes effect on the next request. Their messages show a "Mod" badge, computed at read time. Appointing and removing are step-up admin writes (§19.11). | The pool has exactly **one** admin account (registration closes after the first), behind the nginx IP allowlist + 2FA. Making a helper a second pool admin would open the pool's security core — money, settings, wallets — to give someone chat buttons, and would mean allowlisting their IP. Player-session *authorization* adds no second login system, so D11 still holds: the games service has no admin *authentication*. Every power given is reversible and logged. The password default exists because an IP proof can be a CGNAT neighbour (§19.13 #7). **Amended 2026-10-03 (§19.17, D27/D32):** moderators may also **remove** a nickname — never ban a name or block a player, and never touch the operator's, their own or another moderator's name. A moderator is still a **miner address**; a guest (`g:`) can never be appointed. |

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

**Impact budget — both VPS runs (the first VPS checkpoint and the mainnet acceptance run) MUST prove all five on the live box:**
1. Installing, deploying, restarting, stopping or crashing games never restarts
   `grin-pool-manager` (`systemctl show grin-pool-manager -p NRestarts -p ActiveEnterTimestamp`
   before/after). The ONE planned pool restart is the pool-link code deploy.
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
(`launch` since v2 — §19.17.2; the pool combines it with its own mode and re-probes once after a Go live).

**Pool settings section `games`:**

| Key | Type | Default | Rule |
|---|---|---|---|
| `mode` | enum `off`\|`preview`\|`on` | `off` → **`on`** (§19.17, D30; built 2026-10-04) | combined with the games' launch state (§19.17.2) |
| `chat_enabled` | bool | `false` → **`true`** (§19.17, D30; built 2026-10-04) | — |

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

-- v2 (D21): chat moderators appointed by the operator, and the chat word list
CREATE TABLE moderators (
  address  TEXT PRIMARY KEY REFERENCES players(address),
  added_by TEXT NOT NULL, added_at INTEGER NOT NULL, note TEXT
);
CREATE TABLE chat_words (
  word TEXT PRIMARY KEY, added_by TEXT NOT NULL, added_at INTEGER NOT NULL
);

-- v3 (§19.16): approved nicknames — a request log; the partial unique indexes make
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

-- v4 (§19.17.5): names checked automatically and live at once. 'pending' stays in the
-- nicknames CHECK and stops being written; the migration re-checks the v3 nickname rows (§19.17.5).
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

-- v5 (§19.17.3/§19.17.4): guest accounts. A guest is a players row (address = 'g:' + 16
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
(the participation `badge` was added by the events build, §19.15 *Part 7* #7).
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
posting gate above, as built: "distinct reporters" must mean distinct aged, mining addresses)
and is unique per (message, reporter). Operator messages and your own cannot be reported.

**Keeping open pages current.** A poll asks only for ids after the newest it has,
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

**Moderators (D21).** From /play/, on the public API with their own session:
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
| Settings → **Games** (a pool-owned section) | `mode`, `chat_enabled`, and a read-only games-service health line from the probe |
| `games.html` | games-owned settings via the proxy: plays (§19.6), points, chess (bot play cost; PvP play cost, `pair_rated_daily`, the active / open caps — the move-time options stay manifest values), chat (min proof age with the **1 h floor shown**, password-only switch, recent-mining minutes/days, rate limits, slow mode, hold links, report threshold, word list), retention. It links to the pool-owned switches and does not duplicate them. *As built:* the Games NAV parent; the form is built from the service's own setting spec, so a new key needs no page edit; the word list lives on `games-chat.html`; the PvP group arrived with the PvP build; `mod_requires_password` (D21) is here. |
| `games-chat.html` | the live list, held queue, reports, message actions, operator post box, mod log; **moderators** (D21: list, appoint, remove) |
| `games-players.html` | address lookup (full address, admin only): player row, session count, plays/points, mute/ban/unban, purge, match list with **Void** per voidable match (step-up), `admin_adjust`, appoint/remove as moderator |
| `games-events.html` | event CRUD, results, cancel, finalise-now. The window is picked as whole UTC days with **date** inputs, the last day included (as built: a `datetime-local` snapped to days would show a time that means nothing, §19.15 *Part 7* #12). |
| `games-names.html` | *(§19.16)* the nickname queue (oldest first, with flags), the live and rejected lists; approve / reject (the reason is shown to the player) / remove — all step-up |

The pages follow the pool's admin conventions (AdminTable, the settings-form harvester rules) and
leave the admin CSP unchanged.

**Step-up (`freshAdmin`) is enforced POOL-side before proxying** for: ban, unban, purge, match
void, `admin_adjust`, event cancel, and every games-settings write. Delete-one-message, mute,
approve-held, operator post and event create/update are `secureAdmin` only, so live moderation is
fast. The list lives in `lib/games-link.js`, and the games side re-checks `X-Admin-Stepup`.

**The list is of the FAST writes, and it binds the games admin paths.** GET is
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

So the events and chat admin routes must name those six routes exactly that. Any other write, including one added later
without updating `FAST_WRITES`, defaults to step-up (fail closed). Consequences: unmute and
finalise-now are step-up, and a fast action sent as PUT or DELETE is step-up. The chat build added restore,
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
  nginx error; the first VPS checkpoint verifies that with the snippet absent.

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

**As built (2026-09-27, not VPS-tested).** Everything above is in
`scripts/lib/07_lib_pool_games.sh`; the pool script carries only hooks. Where the build refined
this section (the unit's write paths, the deploy staging, the `version.js` name, the frame CSP's
`sandbox`, `no-cache` on the whole shell, the restore flow, the cron time, the cleanup prompts),
the change and its reason are in §19.15 *Part 3*. The operator-facing walkthrough is impl §10.13
*Part 3*.

### 19.13 Threat notes for the review pass

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
21. **Nicknames (§19.16).** Can any public response carry a nickname without its mask, or a
    pending / rejected one at all? Can a nickname imitate a badge ("Operator", "Mod"), an address, or
    another player's live name (case, separators, leet)? Can two live names share a matching form under
    a race? Can a stranger who mined briefly to an address name it (the aged-proof gate)? Is every admin
    write step-up at the pool? Does a ban end the name? Is the table bounded?

*Added 2026-10-03 by §19.17. The first independent review answers #22–#25, the second #26–#30.*

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
    long one refuses none on the exceptions list — tested with the fixture's innocent list plus the first review's own.
26. **Guest auth (D24).** No account enumeration through login, by timing (dummy scrypt) or wording (one
    `login_failed`; the ban answer only after the password); the only login-namespace oracle is sign-up,
    behind the PoW and the per-IP limit; a rename never answers "taken" for a login name. The per-name
    limiter cannot be armed by a stranger into a permanent lockout (failures only + the known-/24 bypass,
    as §19.15 *Part 4* #3). The scrypt cost is bounded globally (sign-up, login, password change and delete share
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

### 19.14–19.15 Status and build deltas → `script07_implementation_games.md`

Moved to [`script07_implementation_games.md`](script07_implementation_games.md) — each part's deltas under that part, the status table and the reviews under *Build notes (raw)*:
the per-part status table and every build and review record for §19, including the independent
reviews' answer to each §19.13 threat note. Where a record and §19.1–§19.13 differ, the record wins.

### 19.16 Approved nicknames

**Status:** built 2026-09-28, not VPS-tested.

> **Superseded for pre-moderation by §19.17 (D27, 2026-10-03).** Names are now checked automatically
> and live at once; the queue, the `pending` state and the 2–20 / space-and-punctuation rule below are
> replaced by §19.17.5 since 2026-10-04 ( §19.15 *Part C3*). Kept as the history of what the v3 nicknames build shipped — the `names.label`
> rule ("a nickname is never shown alone", for miners) and the request-log table carry over unchanged.

D19 made the masked address the only name in v1 and left nicknames optional; the operator
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

### 19.17 Open community (v2) — site-wide chat, guest accounts, auto-checked names

**Status:** designed 2026-10-03; built 2026-10-04 and independently reviewed twice the same day; not VPS-tested. Build and review records → §19.15 (in the implementation doc).

The operator discussion of 2026-09-28 → 2026-10-03 reopened four things the v1 contract had fixed: where
chat lives (only inside /play/), who may play (miners only), how names are approved (pre-moderated) and
whether the games ship off. This section is the **contract** for that work. It was built in steps with two independent
reviews, and is accepted by one mainnet acceptance run, which **replaces** the v1 acceptance run so the
box is tested once, against the final code. When a build finds this section wrong, it records the change in §19.15 and does not diverge silently.

**Operator answers taken while writing this (2026-10-03):**
1. The header group that holds Fortune Board, Contribute and now Play is named **"Community"** (D31).
2. Donor names **keep their current character set** — `A–Z a–z 0–9 space - _ . & '`, 2–32 characters —
   rather than narrowing to the nickname rule's letters + digits (D29, §19.17.6).
3. The visible word on /play/ becomes **"tickets"**; every internal name (`plays` columns, `plays_*` settings,
   the `no_plays` code, routes) stays as it is (D25, §19.17.4).

**One finding made while writing this, which shapes §19.17.5:** the pool's donor flag-word list is
matched as a **substring** of the matching form, and its own comment accepts the false positives
(`classic` ⊃ `ass`) because "a hit only highlights a queued name, the admin decides". Once names go live
on an automatic verdict, that same matching would refuse *Classic*, *Bassist* and *Cassandra* with "this
name isn't allowed". So the Scunthorpe rule in §19.17.5 covers the **blocked-word list too**, not only the
reserved words the plan named.

#### 19.17.1 Decisions D22–D32 (operator, 2026-09-28 → 2026-10-03)

| # | Decision | Why |
|---|---|---|
| D22 | **Option B — no operator-authored code runs on the pool origin.** Delete the ad type `code` end to end (the renderer in `ads.js`, ad create/update acceptance, the admin form option) and both analytics sinks `analytics.custom_head_html` / `custom_body_html` (the render path in `branding.js` `applyAnalytics` and its `cloneScript`, the settings keys, the branding payload, the admin fields). Analytics stays as **provider-ID loaders only** — GA4, Plausible, Umami — each building its `<script>` from an ID matched by a strict pattern, never from free text. The operator uses GA4 and plans no ad-network code. Image and link ads stay. A stored legacy value (a code ad, saved custom HTML) is ignored, never sent to a browser, and the admin UI says why. **Closes open question O1** (§19.15 *Part 11 review*; audit roll-up P11-4) by removing the sinks rather than opting single pages out of them. | **One origin is one trust zone.** D23 puts a sign-in form on every public page; a script on any page of the origin can read a password typed on any other page of it — `/play/` included, through a same-origin window or iframe — and can ride a session cookie by making requests as the page. O1's fix (exempt the account page) protected one form; with sign-in everywhere there is no page left to exempt. Filtering `<script>` out of the HTML is not a fix: `<img onerror=…>`, `<svg onload=…>` and a dozen other attributes run code, so a sanitiser would be a second thing to get right forever. The sinks go instead. **Residual, accepted (§19.13 #30):** the provider loaders are third-party scripts on the origin too; the operator trusts GA4. |
| D23 | **Floating chat on every page that loads `public-shell.js`**, except pages marked `data-untrusted-html="exempt"` (the pool's `login.html`; `/play/` keeps its own G-07 panel). From the bubble a visitor can **read** chat (anonymous), **sign in** — a miner with address + proof, a guest with name + password — and post. **Sign-up happens only on /play/**, because it needs the proof-of-work (D24). The bubble script is **owned by the games tree** (`/play/js/chat-bubble.js` + its CSS, deployed and stamped with the shell); the pool carries only a tiny loader that inserts it when the branding payload says chat is on in the effective mode (§19.17.7). | One sign-in, available everywhere, without the pool docroot carrying games code. If games is not installed or not healthy the payload says off, so the loader inserts nothing — no games deploy, no bubble — and there is one chat client codebase (the panel and the bubble share a core), not two. |
| D24 | **Guest accounts: name + password, NO email.** Sign-up costs a proof-of-work (a few seconds of browser CPU; a stateless HMAC challenge, single-use), **at most 3 sign-ups per IP per 24 h**, a name passing the nickname rule (D27), and a password of ≥ 10 characters, stored scrypt-hashed. The identity key is **`g:<random>`**, stored in the existing `address` columns, so every games table works unchanged and the pool is **never** called for a guest. The **login name is permanent and is never displayed by the server as a login name** (it starts as the guest's public nickname — see §19.17.3 for what "private" can and cannot mean); the public nickname is separate and may be changed or removed. A guest can change their password and **delete their account**. Idle guest accounts are deleted after `guest_idle_days` (default 180), so names are not squatted forever. | The operator's words: open the games to **non-miners**, without mail infrastructure or personal data. Email would add a mail server (or a third-party sender), a store of personal data and a recovery flow, and buys little: throwaway inboxes defeat it as a Sybil control. Points are worthless (D1), so a lost guest account is a small loss and needs **no recovery path** — "make a new one". A separate login name means removing an offensive nickname never locks its owner out of their account. |
| D25 | **Tickets** (the visible word; internally still `plays`). **Guests: 5 per UTC day**, reset to `guest_daily_plays` at 00:00 UTC — topped back to 5, **never saved up**. **Miners: unchanged (D10)** — 1 per 10 active minutes, ≤ 24 a day — and **banked up to 999** (`plays_balance_cap` default 100 → 999). Hashrate never changes the number. Operator, 2026-10-03: the visible word on /play/ becomes "tickets"; internal names do not change. | The miner benefit is about 5× the games a day plus the right to save them; a farm still cannot buy the boards (D10). The operator found "plays" unclear and used "tickets" themselves; renaming only the visible word keeps every key, column and code stable. |
| D26 | **Guest chat** is allowed once the guest account is ≥ `guest_chat_min_age` old (default 24 h, with the same 1 h floor constant as D9), behind its own switch `chat_guests_enabled` (default on). Guests have stricter rates (1 per 15 s, 10 per hour); a link-like body from a guest is **always** held, whatever `chat_hold_links` says; and **reports by guests never count toward the auto-hold threshold** (they still reach the moderation queue). | Guest accounts are cheap — three sign-ups from one IP a day, more across IPs. Three of them must not be able to hide anyone's message, and the age gate makes a flood need a day's preparation per account. |
| D27 | **Nicknames are auto-checked and live at once** — no pre-moderation (replaces §19.16's queue). **Rule:** 3–20 characters, **`A–Z a–z 0–9` only** — no space, no punctuation, no accents (the operator's explicit choice). Case is kept for display; uniqueness and every word check run on the **matching form** (§19.17.5). **Refused:** reserved words, the pool-owned blocked-word list (D28), the games chat word list, anything address-like (`grin1…` / `tgrin1…`), a **banned name**, a name whose matching form equals a live one. A word-list or reserved hit answers only *"this name isn't allowed"* — no list probing. **One change per `nickname_change_days`** (default 7). Miners still need the aged-proof chat gate to set one. **Admin:** list + search, remove, **ban name** (that matching form can never be taken again), **block player** from nicknames. **Moderators may remove** a nickname — not ban, not block, and never an operator's or another moderator's. **Display:** miners unchanged, `Nick (grin1abcd…wxyz)`; guests `Nick · guest`, or `Guest-XXXX` (derived from the id) with no nickname. | The operator does not want a queue to work through. The reserved words and the list catch most abuse at the door; post-moderation by the operator *and* the moderators catches the rest, and a ban makes a removal stick. ASCII letters + digits kill look-alike letters, RTL tricks and the `free-grin.io`-as-a-name case at once. The aged-proof gate stays for miners because a stranger who mined a few shares to your address must not be able to name you. |
| D28 | **ONE blocked-word list, owned by the POOL** (`names.blocked_words`: an admin textarea, one entry per line, added on top of a seed list in code). It is used by game nicknames and guest sign-up names (sent through the existing `/internal/games/config` route; the games service caches it **and persists the last good copy**, so a pool outage keeps the last list and the seed always applies) and by **donor names**. The games **chat** word list stays games-owned, with chat's HOLD semantics, and is ALSO applied to nicknames (as the v3 nickname `word` flag already did). The pool's `donor_name_blocklist` setting is retired into it. | The pool is the always-on half of the pair, and donor names live in the pool, so the list must live there too. D5 holds: games receives data over the link and never reads pool code or `pool.db`. |
| D29 | **Donor NAMES: the same auto-check, live at once**, with admin remove / ban name / block donor. The character set and length stay as §18.5 (operator's answer). **Donor BANNERS stay pre-moderated** — the operator will revisit banners as a separate topic; nothing in this plan touches the banner path. | A word list can check text; it can never check an image. |
| D30 | **Default ON, first install in PREVIEW.** Pool defaults become `games.mode = 'on'`, `games.chat_enabled = true`. The games DB carries a **launch state** (`meta.launch`; `preview` on a fresh DB, and an absent key reads as `preview`). **The effective mode is the lower of the pool's mode and the launch state** (off < preview < on), applied by every public games route AND reported through the probe so the branding payload, the nav and the bubble follow it. Admin Games → Overview gets **Go live** / **Back to preview** (step-up). No bash writes pool settings. | A safe default for new pools: installing the service never announces it before the operator has done one test run, yet nobody has to find a hidden switch to turn it on. On the live pool the same rule means that deploying games is not a launch. |
| D31 | **Header:** Play moves INTO the dropdown that holds Fortune Board + Contribute, and that group is renamed **"Community"** (operator). The group shows when **any** child is visible — incentives on → Fortune Board + Contribute; games effectively on → Play — and each child keeps its own gate. The footer follows. | Play belongs beside the other "extras". A group whose children are all hidden must disappear, not render as an empty dropdown; a group hidden by one child's flag would hide the other's links. |
| D32 | **Money is unchanged.** Every money action keeps its per-request proof; no games or guest session ever authorises a money route; the Nostr/Goblin destination gate keeps AND+AGE. Moderators stay **miner addresses** (D21) — a guest can never be appointed. | Restated so that no later part "simplifies" it. A session that could withdraw would turn one weak proof — anyone can mine a share to your address — into a 14-day bearer token, and the games service is barred from money by D5 anyway. |

**Amended in place on 2026-10-03 by this section:** D8 (two login kinds), D9 (guest chat age), D10 (balance
cap 999), D12 (default on + launch state), D19 (auto-checked names), D21 (moderators may remove nicknames;
guests are never moderators); §19.16 is now history for the pre-moderation flow. **Still open, carried:**
O2, the moderator-inheritance limit (§19.15 *Part 11 review*) — the mainnet acceptance run asks.

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
  `publicRoute()` gates every public route on it, exactly as it gates on the pool mode today (§19.15 *Part 4* #1:
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
  overrides the default — the live pool may already have saved `off`, and the mainnet acceptance run checks it.

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
| guest login | `{ kind:'guest', name, password }` — either on `/play/api/login` or its own route; the build picks the one that keeps `login.js`'s strict body schema simple, and records why |
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
floor a setting may raise but never remove — the D9 pattern). 18 bits is ~260 k hashes on average: the build
measures the real time with chunked WebCrypto and the mainnet acceptance run times it on a phone; the default moves if either is
far from "a few seconds". *(Measured at build: WebCrypto ~37 k hashes/s in Edge — 7 s on average, 25 s once — so the client
is plain JavaScript over a midstate, ~570 k/s, sign-up ≈ 0.5 s at 18 bits on a desktop; §19.15 *Part C6* #1. The phone
timing is still owed by the mainnet acceptance run.)*

**Sign-up, in this order** (copying §19.5's shape — every cheap refusal before any expensive step):
1. mode gate (`publicRoute`) → `guest_signup_enabled` (games setting, default on — **added by this design**: an
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

**Guest login.** Limits copy §19.15 *Part 4* #3, keyed on the login name: a per-IP bucket; per-IP and per-(name, IP)
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

**Schema v5 — a sketch; the binding text lands in §19.4 in the same change as the migration, because
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
  00:00 UTC"* for guests. Admin pages keep the internal names (the build may add "(tickets)" to a label).

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
case, digit padding, the pool name, address-likes). The first review added 30 of its own.

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

**Moderators (D21 amended):** `POST /play/api/mod/messages/:id/remove-name { reason? }` — the author of a chat message, like mute (built so; this sketch said `/mod/nickname/remove { target }`, but a moderator never holds a full address — §19.15 *Part C3* #8) — remove only; refused on a
moderator's own name, another moderator's and the operator's; one `mod_actions` row as `mod:<address>`.

**Display.** `names.label(id)`: miner → mask, or `Nick (grin1abcd…wxyz)`; guest → `Nick · guest`, or
`Guest-XXXX` (4 base32 characters derived from the id; a label, not an identity); deleted → "deleted guest".
With `nicknames_enabled` off every surface shows the bare mask / `Guest-XXXX`. Uniqueness covers miners and
guests together, so a guest cannot be "Alice" while a miner is.

**Schema v4 — the design sketch; the binding text is now §19.4 (the build added `banned_by`, two refusal-counter columns and a data step were added, §19.15 *Part C3* #10):**

```sql
CREATE TABLE banned_names (
  norm TEXT PRIMARY KEY, name TEXT NOT NULL, banned_at INTEGER NOT NULL, by TEXT NOT NULL, reason TEXT
);
-- players gains nick_blocked INTEGER NOT NULL DEFAULT 0 (0/1) + the last nickname change time (cooldown)
-- nicknames keeps its states; 'pending' simply stops being written
```

**Migration of v3 nickname rows (in the v4 migration).** `pending` → run the v2 checker: pass (and not taken) →
`approved`; fail → `rejected`, reason `rule_v2`. A live name failing the v2 rule (a space, `-`, `_`, `&`,
`'`, two characters) → `removed`, reason `rule_v2`. Nothing is deployed, so no real player loses a name, but
the rule is written so a box that did install v3 nicknames is migrated deterministically.

#### 19.17.6 Donor names (D29) — kind = name only

*Built 2026-10-04; where the build differs from the text below — the ban table's name, a separated word
counting as "whole", which refusals wait for the proofs, the migration's reason text — §19.15 *Part C4* wins.*

- **Shape unchanged (operator):** §18.5 — trim, collapse whitespace, 2–32 characters of
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
  the proof gate (now `requireAgedProof`, one aged proof — design §18.1 #5) stay. **One change per 7 days** — a code constant, not a setting (one more form field
  for a knob nobody turns; promote it if asked).
- **Dots stay** (the operator kept the set): a donor name can still spell a domain. Links are never made
  clickable, and post-moderation removes a scam; recorded as accepted.
- **Admin:** the donors page gets a **Live names** list with remove (the reason shown to the donor), **ban
  name** (the build chooses between a pool `banned_donor_names` table and one banned-names table with a scope
  column, and records why) and **block donor** (the existing `donor_blocks`). The review queue then holds
  banners only. All step-up, as today.
- **Migration:** a `pending` name request is run through the checker (pass → `approved`, fail →
  `rejected`, reason `rule_v2`). Already-approved names are **kept** — a human approved them — and the admin
  list flags any `same_as` pair. `donor_name_blocklist` is retired into `names.blocked_words`: entries the
  operator added beyond the seed are carried over once.
- **Copy:** the donate page and the account page's Donor profile stop saying that names wait for review;
  banners still do. CMS defaults are seed-once, so an installed pool keeps its saved text — the build records the
  operator note.

#### 19.17.7 The floating chat bubble (D23)

- **Files.** `/play/js/chat-bubble.js` + `/play/css/chat-bubble.css`, in the games tree, deployed and
  `?v=` stamped with the shell. The panel (`play-chat.js`) and the bubble share one chat core (the build factors
  it); no copy.
- **Loader (pool).** After the branding payload lands, `public-shell.js` / `branding.js` insert the bubble
  script **only** when `games.chat` is true, the effective mode is `on` — or `preview` **and** the
  localStorage flag `grin_play_preview` is set (the /play/ shell sets it when it loads in preview) — and the
  page is not `data-untrusted-html="exempt"`. Every storage access is in `try/catch`; a throw means "not
  set". The loader is on the D22 script-creator allowlist; a fixed path, never a URL from a payload.
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
- **As built (2026-10-04):** the loader is `loadChatBubble` in `branding.js`; the bubble shares
  `play-chat-core.js` with the panel; the CMS page/post bodies — the one operator-markup sink left on these
  pages — render in a frame sandboxed without `allow-scripts` (D22-4). Departures → §19.15 *Part C7*.

#### 19.17.8 Header group (D31)

`public-shell.js` NAV: the group today labelled **Prize Pool** (🎁) is relabelled **Community** and gains
**Play** as a third child, after Fortune Board and Contribute (the icon is the build's choice — the gift box was
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
| pool donors | `donor_name_blocklist` | **retired** into `names.blocked_words` | — |
| games | `plays_balance_cap` | **999** (was 100) | 1–10000 |
| games | `guest_signup_enabled` | true | bool (added by this design) |
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
`/play/` nginx locations are unchanged apart from one sign-up rate zone. Donor banners (D29). The
miner earning rule (D10) apart from the balance cap. O2 stays open until the mainnet acceptance run.

