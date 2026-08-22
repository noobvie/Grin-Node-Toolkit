# Toolkit-wide Comment Audit — batch plan & session checklist

**Created:** 2026-08-21 · **Scope:** every comment in `.sh`, `.js`, `.html`, `.css`, `.php`,
`.py` that this repo *owns*. Goal: comments match the real code, no duplication, no obsolete
claims.

This file is the **hand-off between chat sessions**. Each session does ONE batch, ticks its
row in the table below, and commits. A new session reads this file first and picks the next
unticked row.

---

## Ground rules (apply to EVERY batch — paste into every session)

1. **Read the code before judging the comment.** Never rewrite a comment from the comment
   alone. If you cannot verify the claim in the code in front of you, mark it `UNVERIFIED`
   in the session report rather than "fixing" it.
2. **Comments only. No logic changes.** If a comment is correct and the *code* is wrong,
   that is a bug: report it in the session summary, do not silently fix it, do not delete
   the comment.
3. **Keep the WHY comments.** This repo deliberately carries long "why / trap / do-not-do-X"
   headers. A comment that explains a non-obvious hazard is valuable even when it looks
   redundant next to the code. Delete only:
   - **WRONG** — contradicts what the code now does
   - **STALE** — describes behaviour, a path, a port, a file or a product state that no
     longer exists
   - **DUPLICATE** — the same explanation repeated verbatim in 3+ places; keep the one at
     the authoritative site, replace the others with a one-line pointer to it
   - **NOISE** — restates the next line (`# loop over files` above a `for`)
4. **Add a comment only for a real trap**, never for coverage. `MISSING` findings go in the
   report; add the comment inline only when the hazard is provable from the code you just read.
5. **Minimal edits.** Do not reflow or restyle a header block you are not correcting.
   The diff should be readable as "these 6 claims changed".
6. **Never edit `web/052_accio/vendor/`** — it is SHA256-pinned and the build hard-fails on a
   changed byte. It is excluded from every batch below.
7. **Never remove or reword an `ACCIO PATCH` marker** in `web/052_accio/patches/` — grepping
   that marker is the only review method that overlay has.
8. **Verify after editing:** `bash -n <file>` for every shell file touched;
   `node --check <file>` for every `.js` touched (plain scripts only — skip ESM/browser files
   that use `import`, just eyeball those).
9. **Known false positives** when grepping for stale markers: `placeholder=` HTML attributes,
   translation strings in `language.js`, CSS section dividers, and the word "temporary"
   inside legitimate tmpfile handling.

## Facts that are known to have drifted — check comments against these

These changed recently, so comments predating them are the most likely to be wrong. Confirm
against the code, not against this list.

- **052 Accio is no longer "reserved"** — the script exists and every menu key is live.
  Any comment calling 052 reserved / planned / coming-soon is stale.
- **Grin Drop moved 052 → 059** (2026-08-04). Comments naming Drop as 052 are stale.
- **Transporter moved 092 → 093** (2026-08-04); 092 is now reserved for the mwixnet mixer.
- **Hub 05 uses FIXED menu slots**; hub 08 keys rows to the script's last digit. Comments
  describing positional keys, or claiming "key N = script 05N", are stale.
- **`/v1/` node REST API does not exist** (removed in grin 5.x). Any comment referencing a
  `/v1/` endpoint is wrong.
- **grin-wallet DOES accept a passphrase on stdin.** Comments claiming "`-p` is the only
  option / no stdin or env-var input" are wrong — several are known to still exist.
- **Node API secret VALUES no longer rotate on rebuild** (key vault at `/opt/grin/keys/<net>/`);
  only the secret *path* moves. Comments promising rotation-on-rebuild are stale.
- **`flowcharts/` was merged into `docs/generated/`.** Path references to `flowcharts/` are dead.
- **Drop's wallet 3415 is retired** — combined listener on 3420/13420.
- **Lib files run WITHOUT errexit.** Any lib header claiming "the caller's `set -e` covers
  this" is wrong and must be corrected, not deleted.

---

## Batch table

Tick `Done` and add the commit hash when a session finishes. `~C` = comment lines in scope
(shell) or total lines in scope (web), i.e. rough session weight.

### Tier 1 — shell scripts (`scripts/`), highest value

| # | Batch | Files | ~C | Done |
|---|---|---|---|---|
| A1 | Node build | `scripts/01_build_new_grin_node.sh`, `lib/01_lib_source_build.sh`, `lib/grin_node_control.sh`, `lib/grin_node_keepalive.sh` | 1473 | ☑ |
| A2 | Chain data + file server | `scripts/03_grin_share_chain_data.sh`, `lib/03_lib_remote.sh`, `scripts/02_nginx_fileserver_manager.sh`, `lib/02_lib_landing.sh` | 1319 | ☑ |
| A3 | Node API + health + explorers | `scripts/04_grin_node_foreign_api.sh`, `scripts/06_global_grin_health.sh`, `lib/06b_grinscan.sh`, `lib/06d_tiny_explorer.sh`, `lib/nginx_shared_helpers.sh` | 1038 | ☑ |
| A4 | Solo mining | `scripts/07_grin_mining_solo.sh`, `lib/07_solo_wallet.sh`, `lib/07_solo_backup.sh`, `lib/07_solo_quiet.sh`, `scripts/07_grin_mining_hub_services.sh`, `lib/07_lib_hub.sh` | 1011 | ☑ |
| A5 | Public pool (shell) | `scripts/07_grin_mining_public_pool.sh`, `lib/07_lib_pool_wallet.sh`, `lib/07_lib_pool_backup.sh`, `lib/07_lib_gateway.sh`, `lib/07_lib_gwctl.sh` | 1102 | ☑ |
| A6 | Wallet hub + Fidelius | `scripts/05_grin_wallet_service.sh`, `scripts/051_grin_fidelius.sh`, `scripts/051x_grin_xp_wallet.sh`, `lib/grin_wallet_install.sh`, `lib/grin_wg_access.sh` | 1346 | ☑ |
| A7 | Accio build + vendor (shell) | `scripts/052_grin_accio.sh`, `lib/052_lib_build.sh`, `lib/052_lib_vendor.sh` | 1242 | ☑ |
| A8 | Accio gateway + nginx (shell) | `lib/052_lib_gateway.sh`, `lib/052_lib_nginx.sh` | 967 | ☑ |
| A9 | Drop + WooCommerce | `scripts/059_grin_drop.sh`, `lib/059_lib_{wallet,backup,nginx,admin,app}.sh`, `scripts/053_grin_woocommerce.sh` | 629 | ☑ |
| A10 | Admin band 08x + backup | `scripts/08_grin_node_admin.sh`, `081`, `082`, `084`, `085`, `089`, `08del`, `lib/grin_backup_engine.sh`, `lib/grin_backup_push.sh` | 1159 | ☑ |
| A11 | Connectivity 09 + shared | `scripts/09_grin_comms_hub.sh`, `091`, `lib/091_lib_floonet.sh`, `093`, `lib/093_lib_{server,client,backup}.sh`, `lib/nostr_relay_deploy.sh`, `lib/grin_node_secrets.sh`, `lib/grin_alerts.sh`, `grin-node-toolkit.sh` | 1072 | ☑ |

### Tier 2 — public pool web app (largest JS surface)

| # | Batch | Files | ~L | Done |
|---|---|---|---|---|
| B1 | Pool router monolith | `back-end-pool/index.js` | 6062 | ☑ |
| B2 | Pool money & wallet libs | `lib/withdrawal-scheduler.js`, `wallet.js`, `wallet-tor.js`, `nostr-payout.js`, `rewards.js`, `reconciliation.js`, `dormancy.js`, `blocks.js` | ~3900 | ☑ |
| B3 | Pool infra libs | `lib/db.js`, `pool-settings.js`, `config.js`, `auth.js`, `rate-limiter.js`, `ip-filter.js`, `owner-proof.js`, `retention.js`, `miners.js` | ~4900 | ☑ |
| B4 | Pool stratum & stats libs | `lib/stratum-server.js`, `node-stratum-client.js`, `hashrate-tracker.js`, `grin-node.js`, `poolstats-reporter.js`, `alert-monitor.js`, `alert-delivery.js` | ~3300 | ☑ |
| B5 | Pool content & incentives libs | `lib/posts.js`, `ads.js`, `lottery.js`, `incentives.js`, `back-end-pool/scripts/*.js` | ~2000 | ☑ |
| B6 | Admin panel JS/CSS | `admin-panel/settings-common.js`, `admin-shell.js`, `styles.css`, `settings.css` | ~3400 | ☑ |
| B7 | Admin panel HTML | `admin-panel/*.html` (~15 files) | ~5000 | ☑ |
| B8 | Public site JS | `public_html/js/*.js` (skip `js/vendor/`) | ~4400 | ☑ |
| B9 | Public site HTML + CSS | `public_html/*.html`, `public_html/css/*.css` | ~9700 | ☑ |

### Tier 3 — other web products

| # | Batch | Files | ~L | Done |
|---|---|---|---|---|
| C1 | Accio gateway (ours, 0 deps) | `web/052_accio/gateway/**` | 5233 | ☑ |
| C2 | Accio patches overlay — **special rules below** | `web/052_accio/patches/**` | 19268 | ☑ |
| C3 | Fidelius + XP wallet | `web/051_fidelius/**`, `web/051_xp_wallet/**` | 9245 | ☑ |
| C4 | Stats map + GrinScan + Tiny Explorer | `web/06_stats_map/**`, `web/06b_grinscan/**`, `web/06d_tiny_explorer/**` | 15554 | ☑ |
| C5 | Drop + WooCommerce web | `web/059_drop/**`, `web/053_woocommerce/**` | 9386 | ☑ |
| C6 | Transporter + node API + solo pool web | `web/093_transporter/**`, `web/04_node_api/**`, `web/07_mining_pool_solo/**` | 7104 | ☑ |

### Tier 4 — final sweep (run LAST, after every batch above)

| # | Batch | What | Done |
|---|---|---|---|
| D1 | Cross-file duplication | Find explanations repeated across files (node launch contract, hashrate formula, secret paths, menu-key rules) and collapse to one authoritative site + pointers | ☑ |
| D2 | Doc ↔ code drift | Check `CLAUDE.md`, `README.md` and `docs/generated/script##_*.md` claims against what the audited comments now say; fix the docs, not the code | ☑ |

**C2 special rules:** `patches/` holds de-branded copies of pinned upstream files. Treat every
comment there as read-only *unless* it is an `ACCIO PATCH` marker whose description no longer
matches the patch beside it. Never add, remove or reword a marker to "tidy" it; never touch a
comment that came from upstream. Report, do not edit, anything ambiguous. Cross-check against
`web/052_accio/patches/README.md` (the 19-file table) — a patch present in a file but absent
from that table is a finding.

---

## Per-session prompt template

Paste this into a fresh chat, filling in the batch id and file list from the table:

> Read `docs/generated/script00_analysis_comment_audit.md` first — I'm running batch **A1**
> of the toolkit comment audit.
>
> Review every comment in: *(file list from that row)*
>
> Follow the ground rules in that file exactly. For each file: read the real code, then judge
> each comment as OK / WRONG / STALE / DUPLICATE / NOISE / MISSING. Fix WRONG, STALE,
> DUPLICATE and NOISE in place with minimal edits. Do not change logic. Run `bash -n` on every
> shell file you touch (or `node --check` for plain-CommonJS `.js`).
>
> When done: give me a short table of what you changed and why, a separate list of anything
> you could not verify, and a list of any *code* bugs the comments exposed. Then tick the
> batch row in the audit file, add a session-log line, and commit with message
> `docs(comments): audit batch A1 — <short scope>`.

---

## Tier 1 complete — carry-forward for D1 / D2

Tier 1 (A1–A11) finished 2026-08-21. Findings that are NOT comment fixes, parked
for the batches that own them.

### Code bugs found while auditing comments (comment correct, code wrong)
| Where | Bug |
|---|---|
| `scripts/02_nginx_fileserver_manager.sh` (enhance-security step 2) | writes `limit_req_zone ... zone=grin_req` inline into `/etc/nginx/conf.d/grin_limit_req.conf` instead of calling `nginx_ensure_rate_limit_zone`. Violates CLAUDE.md nginx rule 1. |
| `scripts/06_global_grin_health.sh` (two operator hints) | prints "Configure (B→2)" for the Rocket explorer; it has been menu **C** since GrinScan took B. |
| `scripts/081_host_monitor_port.sh` (`max_age=5`) | flat 5-day staleness threshold for every site_key. Script 01 allows **70** for `fullmain` because the archive publishes biweekly, so a healthy full-archive mirror reads STALE on all but the first five days after a publish. |
| Accio (`web/052_accio` + `scripts/089_backup_restore.sh`) | `/opt/grin/accio-<net>/gateway-state/` is in **no backup at all**. 052's own comments call it durable state whose loss changes the receiving address of every wallet that ever connected; 089 does not collect it and 052 ships no product backup. Only product in that position. |

### Doc drift for D2 (fix the doc, not the code)
- **CLAUDE.md** says the shared `grin_api` zone is `30r/m`. It is **`300r/m`** — `nginx_ensure_grin_api_zone` in `lib/nginx_shared_helpers.sh`, used by 04 and 06.
- **CLAUDE.md** lists `lib/07_lib_pool_wallet.sh` under "Still on `-p`". The pool listener has **no passphrase in argv**: it boots locked and unlocks over ECDH. `-p` survives only in a one-shot `address` probe. The remaining `-p` users are `lib/07_solo_wallet.sh` and `lib/059_lib_wallet.sh`.
- **CLAUDE.md / memory** framed rpassword 7 as a pending time bomb for stdin-fed passphrases. It landed and did **not** break: grin-wallet v5.5.0 pins rpassword 7.5.4 but branches on `stdin.is_terminal()`. Comments in `grin_wallet_install.sh` and `051` were corrected; the pin (`v5.4.1`) is unchanged.
- ~~`docs/generated/script051_design_node_port_2026-05-24.md` breaks the naming rule in this file's own conventions (should be `script051_design.md`; the date suffix is only for multiple versions).~~ **Fixed in D2** — `git mv`d to `script051_design.md`; the one pointer to it (`scripts/051_grin_fidelius.sh:10`) was updated.

### Note on A2
The 02 half of A2 is committed. The comment edits to `scripts/03_grin_share_chain_data.sh`
and `scripts/lib/03_lib_remote.sh` were made but deliberately **left uncommitted**: both
files carry the operator's in-progress Script-03 redesign, and staging them would have
swept unfinished work into a `docs(comments)` commit. They ride along with that work.

---

## Tier 3 complete — carry-forward for D1 / D2

Tier 3 (C1–C6) finished 2026-08-21. Same rule as Tier 1: what is not a comment fix
is parked for the batch that owns it.

### Code bugs found while auditing comments (comment correct, code wrong)
| Where | Bug |
|---|---|
| `web/059_drop/server/app.js` (`GET /api/nodes`) | Node reachability is decided by a bare `GET https://<node>/v2/foreign` and any 2xx/3xx/404/405 counts as **online**. `/v2/foreign` is POST-only JSON-RPC, so a parked domain, a CDN error page or an unrelated web server on that host all report the node as up. CLAUDE.md's rule is explicit: only a parsed, unwrapped `{"Ok":…}` proves a Grin node. The comment above the code describes the technique accurately — the technique is the bug. (GrinScan and Fidelius both do this correctly; Fidelius's own comment records the same fix being made there.) |
| `web/059_drop/server/app.js` + `public_html/js/faucet.js` | `GRIN_ADDR_RE` accepts `prefix + 40` chars (min 45/46) and the client mirrors it, but the server's rejection message says "52+ chars" and a real slatepack address is 63/64. Cosmetic today — the wallet rejects a short address later — but the message and the check disagree. |

### Doc drift for D2 (fix the doc, not the code)
- **CLAUDE.md** and `patches/README.md` said "upstream's **22** stylesheets are NOT overlaid".
  `vendor/upstream-wallet/public_html/styles/` holds **21** `.css` files plus a licence text
  file, and upstream's `index.html` links exactly 21. `patches/README.md` is fixed; CLAUDE.md
  still says 22.
- **`scripts/04_grin_node_foreign_api.sh:1872`** prints `info "Grin data dir owner
  (node-collector will run as): $grin_user"`, but the cron it then writes runs the
  node-collector **as root** (`* * * * * root python3 …`) — `$grin_user` is only ever a
  displayed value. Found during the C1–C6 self-review while verifying the collector
  docstrings; it is a user-visible string in a shell script, so it belongs to the A batches
  and was left for D2 rather than edited here.
- `web/052_accio/patches/README.md` header still describes the overlay as if S5 had not run
  ("empty until S5"); fixed here, but the same "(empty until …)" phrasing pattern was also on
  `gateway/README.md` and may exist in other per-product READMEs not in this audit's scope.

### Things verified rather than changed (so a later batch does not re-derive them)
- **No unmarked patch remains in `patches/`.** Every diff hunk against `vendor/` in all 12
  text-format patched files sits within reach of an `ACCIO PATCH` marker (checked
  mechanically, `diff -U0` hunk ranges vs marker line numbers). The 19-file table in
  `patches/README.md` matches the 19 files on disk exactly, and every ✅/❌ matches whether
  that file actually carries a marker.
- **The two brand maps are identical** — 12 pairs each in `backend/language.php` and
  `scripts/language.js`, extracted and compared programmatically (this is the R8 check).
- **`mqs.js`'s reduction note is exact**: 5 external symbols in 36 references across
  api.js / slate.js / wallet.js / hardware_wallet.js / send_payment_section.js. Re-counted.
- **`site.webmanifest`'s "twelve handlers"** — 4 mwc + 4 grin + 4 epic upstream, 8 removed. ✓
- `resources.php`'s icon note says "8 touch-icon PNGs"; the list it empties holds 9 raster
  entries (8 sized + `apple-touch-icon.png`). Its "33 PNGs" total is right only if that ninth
  one is counted. Left alone under the C2 report-don't-edit rule.
- **Accio gateway test suite passes** (`node --test` in `web/052_accio/gateway/`, 78/78) after
  the comment edits; nothing there is deployed to a VPS (`test/` is not copied by the installer).

---

## Tier 4 — D1 / D2 (final sweep)

Run 2026-08-22, after every A/B/C batch. D1 first, then D2.

### D1 — cross-file duplication: **nothing to collapse**

This was checked mechanically, not by eye, over the **270 owned files** (`scripts/**` +
`web/**`, minus `web/052_accio/vendor/`, `web/052_accio/patches/` and `js/vendor/`):

1. **Every comment line ≥45 chars, normalised, counted by distinct file.** 19,665 distinct
   comment lines; **41** appear in 3+ files.
2. **Every run of 3 consecutive comment lines**, same normalisation. Across all 270 files
   exactly **one** such block repeats in 3+ files — and it is a `source` annotation plus a
   `shellcheck source=` directive in `02` / `04` / `06`, i.e. the pointer pattern D1 wants.

All 41 single-line hits are one of five benign classes, none of them a repeated *explanation*:
section dividers (`─── Logging ───`, 17 files), per-script boilerplate headers, `shellcheck
source=` directives, **comments inside heredocs** (these are generated-file *content* written
onto the VPS — editing them is a logic change, not a comment fix), and 1–2 line
"what this `source` line is for" notes.

The four clusters D1 named were then read in full rather than grepped, and each is already
one authoritative site plus per-site pointers:

| Cluster | Authoritative site | Verdict |
|---|---|---|
| Node launch contract | `lib/grin_node_control.sh` header (two-tmux-server rationale) | Call sites in `01`, `03`, `04`, `07` describe only their *local* step and two of them name the launch contract explicitly. No copy of the rationale. |
| Hashrate formula | `.claude/CLAUDE.md` + `lib/06_collector.py:483` docstring | The other sites are one-liners that already say "see CLAUDE.md" / "matches 06_collector.py". The three blocks in `06_collector.py` compute, invert, and window it — different jobs, not copies. `06b_grinscan/server.js` restates the constants inline; left alone deliberately, because the arithmetic is on the next line and a pointer-only comment would send the reader out of the file to check what they are looking at. |
| Secret paths | `lib/grin_node_secrets.sh` | The repeats are 2-line annotations above the `source` line / above `grin_install_secret_sync`. Checked for **contradiction** rather than repetition: node `.api_secret`=Owner, `.foreign_api_secret`=Foreign, wallet `.owner_api_secret`/`.foreign_api_secret` — consistent everywhere. |
| Menu-key rules | `05_grin_wallet_service.sh` header (fixed slots), `08_grin_node_admin.sh:17` (key = last digit), `09_grin_comms_hub.sh:38` (positional) | One rule stated once per hub, each naming the others' rule to say it is *not* using it. Renumber history (Drop `052→059`, Transporter `092→093`) is told in full once each, in the owning hub header; the other sites are one-line legacy-tag notes at the code that handles the old tag. |

Two further cross-file checks for **contradiction between copies** (the actual risk of
duplication, which a "collapse" pass would not catch) also came back clean: the `3415`
retirement (Drop/solo say retired, hub 05 correctly still documents `listen`-mode binding it —
a different mode, not a contradiction), and the `/v1/` warning (stated once, in
`web/051_fidelius/server.js`, where the bug happened; the two `/api/v1/` hits in the floonet
libs are the *relay's* own API and unrelated).

**One thing D1 did surface** is not duplication but the opposite — the errexit fact is stated
at two fidelity levels: the full "the caller's `set -e` does NOT reach in here, guard your own
commands" version in 6 libs, and a bare `Convention: sourced lib → NO shebang / NO set -e.` in
10 others. Nothing is *wrong* (no lib claims the caller's `set -e` covers it — that was the
drift the A batches fixed), and each long copy adds something local, so nothing was edited.
Recorded here so a later reader does not re-derive it.

### D2 — doc ↔ code drift: 19 fixes

Every carried-forward item from Tier 1 and Tier 3 was re-verified against the code before
editing, and the sweep found more.

**The big one — the pool's node stratum upstream port is `3416`, not `3334`.** This was wrong
in **all three** doc surfaces simultaneously (`CLAUDE.md`, `README.md`, `script07_design.md`,
`script07_implementation.md`, `script09_design.md` — 11 sites). The code is unambiguous and
self-consistent at three independent sites: `pool_ensure_defaults` in
`07_grin_mining_public_pool.sh` (`d_node_strat=3416/13416`), `node_stratum_port` in
`back-end-pool/lib/config.js`, and `grin_sync_pool_stratum` in `lib/grin_node_secrets.sh`,
which re-patches `stratum_server_addr` to that port after a node rebuild. All three carry the
same reason: Script 01 deliberately does not touch `stratum_server_addr`, so the pool must dial
grin's own default. `3334` was a 2026-06 plan that was never implemented —
`script07_implementation.md` even ticked it off as "bash + backend in sync". The docs now say
`3416`, and each fixed site records that `3334` was planned and dropped, so this does not get
"corrected" back.

| # | Doc | Claim | Now |
|---|---|---|---|
| 1 | CLAUDE.md | node stratum upstream `127.0.0.1:3334` / `13334` | `3416` / `13416`, + the three code sites that must stay agreed |
| 2 | CLAUDE.md | Central API `8080` | `8080`, testnet `8090` |
| 3 | CLAUDE.md | upstream's **22** stylesheets | **21** (21 `.css` + 1 licence text = 22 dir entries — the miscount's origin) |
| 4 | CLAUDE.md | `grin_api` zone `30r/m` | **`300r/m`** (`nginx_ensure_grin_api_zone`) |
| 5 | CLAUDE.md | `nginx_ensure_rate_limit_zone <zone> <rate> [size] [conf]` | + the undocumented 5th `force` arg, which is how a rate edit in the lib actually reaches an installed box — and which `nginx_ensure_grin_api_zone` passes |
| 6 | CLAUDE.md | "Still on `-p`" includes `lib/07_lib_pool_wallet.sh` | Removed: the pool listener starts `owner_api` with **no passphrase in argv** (`07_lib_pool_wallet.sh:262/264`) and unlocks over ECDH. `-p` survives there only in `init` and a one-shot `address` probe — bounded, not a 24/7 leak. `07_solo_wallet.sh:156` and `059_lib_wallet.sh` are the real ones. |
| 7 | CLAUDE.md | rpassword 7 framed as a pending risk | Records that it landed and did **not** break stdin (v5.5.0 pins 7.5.4, branches on `is_terminal()`); pin unchanged at v5.4.1 |
| 8 | README.md | "Two numbers are deliberately **reserved**: `052` … and `092`" | `092` only. 052 stopped being a reservation when Accio's build started — and README line 171 already said it was built, so the file contradicted itself |
| 9 | README.md | pool port table: `3334`/`13334`; no testnet rows | `3416`/`13416`, + the missing `13333` public stratum and `8090` central API rows |
| 10 | script07_design.md | 3334 × 4, testnet public stratum `3333`, testnet Central API `8080` | `3416`/`13416`, `13333`, `8090`; the "migrated to 3333/3334/8080" note now records that the upstream was never moved |
| 11 | script07_implementation.md | 3334 × 5, incl. the "✅ ports reconciled … bash + backend in sync" row and an ASCII diagram | all `3416`/`13416`; testnet paragraph gained `8090` + `13333` |
| 12 | script09_design.md | taken-ports list included `3334` | `3416` |
| 13 | script05_implementation.md | `052` = "**RESERVED, unbuilt** — the only reservation" (×3 incl. the Phase-4 resolution note) | built 2026-08-09/10 (never VPS-run); the 05 band now holds no reservation, `092` is the toolkit's only one |
| 14 | `script051_design_node_port_2026-05-24.md` | filename breaks this file's own naming rule | `git mv` → `script051_design.md`; pointer in `051_grin_fidelius.sh:10` updated |

**Three code edits**, both carried forward to D2 by earlier batches (a user-visible string and
two comments in a shell script — no logic changed, `bash -n` clean):

| Where | Was | Now |
|---|---|---|
| `04_grin_node_foreign_api.sh:117` | header: "node-collector.py runs as the grin OS user" | runs as **root** (that is what the cron it writes says) |
| `04_grin_node_foreign_api.sh:1872` | `info "Grin data dir owner (node-collector will run as): $grin_user"` | "(informational; the collector cron runs as root)" — `grin_user` is **display-only**: grepped all 5 uses, it is never passed to a chown, chmod or cron user field |
| `04_grin_node_foreign_api.sh:1883` | "grin_user gets group-write via the web-user group so node-collector can write node.json" | describes what 775 + web-user ownership actually does; the node-collector writes as root regardless |

### Verified, not changed (so a later reader does not re-derive)
- **Hub 08's key mapping holds exactly** as CLAUDE.md describes it: `1`→081, `2`→082,
  `4`→084, `5`→085, `9`→089, gaps `3`/`6`/`7`/`8` filled by inline features, and `10`
  surviving as the documented silent alias for Backup.
- Accio counts all re-derived and correct: **19** patched files (20 in `patches/` minus its
  README), **9** gateway modules, `"dependencies": {}`, **4** `052_lib_*.sh` libs, 2 vendored
  upstreams.
- Node/wallet port table, reboot autostart delays (mainnet 5 s / testnet 1000 s), the 5-min
  `grin-secret-sync` timer, and the `Result` unwrapping rule all match the code.
- `flowcharts/` still appears in two `script07_*.md` headings, but as **provenance**
  ("merged from flowcharts/… 2026-07-09"), not as a live path. Correct as history; left.

### Open findings from D2 (reported, not fixed)
1. **CLAUDE.md's generated-doc naming rule does not match `docs/generated/` itself.** The rule
   allows `design`/`implementation`/`security_audit`/`analysis`/`reference`/`report`; the
   directory also uses `flow_chart` (×4), `planning` (×3), `realization` (×2), `gotchas`,
   `ipv6_extension`, `to_be_done`, and one `script01-03_` multi-script prefix — 12 files. Only
   the one file already carried forward was renamed: the rest are cross-referenced from code
   comments, and a mass rename is a scope decision for the operator, not a comment audit. Either
   widen the rule's type list or plan one rename pass.
2. **Tier 2 (B1–9) never got a carry-forward section.** Tier 1 and Tier 3 each parked their
   code bugs here; the B batches recorded counts in the session log only (**9 code bugs +
   1 dead file + 1 doc/UX conflict** across B2–B9, per those lines) but not what they were.
   Those findings are not recoverable from this file and are not in D1/D2's scope to
   re-derive. If they matter, the pool web app needs a bug-only re-read.
3. Everything still open from the Tier 1 and Tier 3 tables above (the `02` inline
   `limit_req_zone`, `06`'s `B→2` hint, `081`'s flat `max_age=5`, Accio's unbacked-up
   `gateway-state/`, Drop's `GET /v2/foreign` reachability probe and its `GRIN_ADDR_RE`
   message) is a **code** bug and was deliberately left for the operator — D1/D2 change docs
   and comments only.

---

## Session log

Append one line per finished batch:
`<batch> — <date> — <commit> — <n edits, n unverified, n code bugs found>`
`A1 — 2026-08-21 — 77cdbe1.. — 13 edits, 0 unverified, 0 code bugs`
`A2 — 2026-08-21 — 02 + landing committed; the 03 / 03_lib_remote comment edits sit in the working tree with the operator's in-progress 03 redesign — 13 edits, 0 unverified, 0 code bugs`
`A3 — 2026-08-21 — see commit — 16 edits, 0 unverified, 2 code bugs`
`A4 — 2026-08-21 — see commit — 4 edits, 0 unverified, 0 code bugs`
`A5 — 2026-08-21 — see commit — 5 edits, 0 unverified, 0 code bugs`
`A6 — 2026-08-21 — see commit — 6 edits, 0 unverified, 0 code bugs`
`B1 — 2026-08-21 — working tree (operator has concurrent feature edits in index.js) — 27 edits, 0 unverified, 0 code bugs`
`B2 — 2026-08-21 — working tree — 8 edits, 0 unverified, 3 code bugs`
`B3 — 2026-08-21 — working tree — 15 edits, 0 unverified, 2 code bugs`
`B4 — 2026-08-21 — working tree — 15 edits, 0 unverified, 3 code bugs`
`B5 — 2026-08-21 — working tree — 3 edits, 0 unverified, 1 code bug`
`B6 — 2026-08-21 — working tree — 1 edit, 0 unverified, 0 code bugs`
`B7 — 2026-08-21 — working tree — 9 edits (stray split-artifact TAB markers), 0 unverified, 0 code bugs`
`B8 — 2026-08-21 — working tree — 10 edits, 0 unverified, 1 dead file (js/theme.js)`
`B9 — 2026-08-21 — working tree — 2 edits, 0 unverified, 1 doc/UX conflict (luck definition)`
`B1–B9 self-review — 2026-08-21 — working tree — re-verified all 12 asserted-fact comments against source (all held); found the tag sweep had keyed on <!-- --> only, so // comments inside <script> blocks were missed: +7 edits in admin-panel/payments.html, public_html/login.html, scripts/test-stratum-guards.js. Pool is now tag-free except the one documented `review finding #1` in dormancy.js.`
`A7 — 2026-08-21 — see commit — 0 edits, 0 unverified, 0 code bugs (counts re-derived, all correct)`
`A8 — 2026-08-21 — see commit — 1 edit, 0 unverified, 0 code bugs`
`A9 — 2026-08-21 — see commit — 3 edits, 0 unverified, 0 code bugs`
`A10 — 2026-08-21 — see commit — 3 edits, 0 unverified, 2 code bugs`
`A11 — 2026-08-21 — see commit — 3 edits, 0 unverified, 0 code bugs`
`C1 — 2026-08-21 — see commit — 6 edits, 0 unverified, 0 code bugs (suite re-run 78/78)`
`C2 — 2026-08-21 — see commit — 6 edits (3 in patches/README.md, 3 stale line-number citations in index.html markers), 0 unverified, 0 code bugs; no unmarked patch found`
`C3 — 2026-08-21 — see commit — 3 edits, 0 unverified, 0 code bugs`
`C4 — 2026-08-21 — see commit — 0 edits, 0 unverified, 0 code bugs (claims re-derived: banner TTL, PUBLIC_NODES parity, peer-map dedup, slatepack wire format)`
`C5 — 2026-08-21 — see commit — 1 edit, 0 unverified, 2 code bugs`
`C6 — 2026-08-21 — see commit — 4 edits, 0 unverified, 0 code bugs`
`C1–C6 self-review — 2026-08-22 — working tree — re-read every edit made in Tier 3. Four defects in my OWN edits, all fixed: two comment blocks left an over-long line where the reflow broke the ~80-col wrap (listen_route.js, server.js); the R7 parenthetical said "clamped it to 128 KB" when R7 dropped the DEFAULT to 128 KB and separately added a load-time clamp to inbound_max_forwardable (~192 KB at the default frame size) — reworded in listen_route.js and tor_route.js; socks5.js claimed ws.js is "hand-written for the one frame type this rail sends", but ws.js implements masking, all three length encodings, continuation frames, control frames and the close handshake, and the server itself sends pings — now points at ws.js's own header instead. Suite re-run 78/78. Every other Tier 3 claim re-verified against source and held (option 8, /opt/grin/grin-api-collector/, the 051x header pointer, Drop's wallet_foreign_api_port, 21 stylesheets, 19 k patched lines).`
`D1 — 2026-08-22 — see commit — 0 edits (nothing to collapse; 270 files scanned mechanically, 4 named clusters read in full), 0 unverified, 0 code bugs`
`D2 — 2026-08-22 — see commit — 19 edits across 7 docs + 1 shell file (11 of them one wrong port), 0 unverified, 3 open findings`
