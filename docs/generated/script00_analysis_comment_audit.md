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
| A7 | Accio build + vendor (shell) | `scripts/052_grin_accio.sh`, `lib/052_lib_build.sh`, `lib/052_lib_vendor.sh` | 1242 | ☐ |
| A8 | Accio gateway + nginx (shell) | `lib/052_lib_gateway.sh`, `lib/052_lib_nginx.sh` | 967 | ☐ |
| A9 | Drop + WooCommerce | `scripts/059_grin_drop.sh`, `lib/059_lib_{wallet,backup,nginx,admin,app}.sh`, `scripts/053_grin_woocommerce.sh` | 629 | ☐ |
| A10 | Admin band 08x + backup | `scripts/08_grin_node_admin.sh`, `081`, `082`, `084`, `085`, `089`, `08del`, `lib/grin_backup_engine.sh`, `lib/grin_backup_push.sh` | 1159 | ☐ |
| A11 | Connectivity 09 + shared | `scripts/09_grin_comms_hub.sh`, `091`, `lib/091_lib_floonet.sh`, `093`, `lib/093_lib_{server,client,backup}.sh`, `lib/nostr_relay_deploy.sh`, `lib/grin_node_secrets.sh`, `lib/grin_alerts.sh`, `grin-node-toolkit.sh` | 1072 | ☐ |

### Tier 2 — public pool web app (largest JS surface)

| # | Batch | Files | ~L | Done |
|---|---|---|---|---|
| B1 | Pool router monolith | `back-end-pool/index.js` | 6062 | ☐ |
| B2 | Pool money & wallet libs | `lib/withdrawal-scheduler.js`, `wallet.js`, `wallet-tor.js`, `nostr-payout.js`, `rewards.js`, `reconciliation.js`, `dormancy.js`, `blocks.js` | ~3900 | ☐ |
| B3 | Pool infra libs | `lib/db.js`, `pool-settings.js`, `config.js`, `auth.js`, `rate-limiter.js`, `ip-filter.js`, `owner-proof.js`, `retention.js`, `miners.js` | ~4900 | ☐ |
| B4 | Pool stratum & stats libs | `lib/stratum-server.js`, `node-stratum-client.js`, `hashrate-tracker.js`, `grin-node.js`, `poolstats-reporter.js`, `alert-monitor.js`, `alert-delivery.js` | ~3300 | ☐ |
| B5 | Pool content & incentives libs | `lib/posts.js`, `ads.js`, `lottery.js`, `incentives.js`, `back-end-pool/scripts/*.js` | ~2000 | ☐ |
| B6 | Admin panel JS/CSS | `admin-panel/settings-common.js`, `admin-shell.js`, `styles.css`, `settings.css` | ~3400 | ☐ |
| B7 | Admin panel HTML | `admin-panel/*.html` (~15 files) | ~5000 | ☐ |
| B8 | Public site JS | `public_html/js/*.js` (skip `js/vendor/`) | ~4400 | ☐ |
| B9 | Public site HTML + CSS | `public_html/*.html`, `public_html/css/*.css` | ~9700 | ☐ |

### Tier 3 — other web products

| # | Batch | Files | ~L | Done |
|---|---|---|---|---|
| C1 | Accio gateway (ours, 0 deps) | `web/052_accio/gateway/**` | 5233 | ☐ |
| C2 | Accio patches overlay — **special rules below** | `web/052_accio/patches/**` | 19268 | ☐ |
| C3 | Fidelius + XP wallet | `web/051_fidelius/**`, `web/051_xp_wallet/**` | 9245 | ☐ |
| C4 | Stats map + GrinScan + Tiny Explorer | `web/06_stats_map/**`, `web/06b_grinscan/**`, `web/06d_tiny_explorer/**` | 15554 | ☐ |
| C5 | Drop + WooCommerce web | `web/059_drop/**`, `web/053_woocommerce/**` | 9386 | ☐ |
| C6 | Transporter + node API + solo pool web | `web/093_transporter/**`, `web/04_node_api/**`, `web/07_mining_pool_solo/**` | 7104 | ☐ |

### Tier 4 — final sweep (run LAST, after every batch above)

| # | Batch | What | Done |
|---|---|---|---|
| D1 | Cross-file duplication | Find explanations repeated across files (node launch contract, hashrate formula, secret paths, menu-key rules) and collapse to one authoritative site + pointers | ☐ |
| D2 | Doc ↔ code drift | Check `CLAUDE.md`, `README.md` and `docs/generated/script##_*.md` claims against what the audited comments now say; fix the docs, not the code | ☐ |

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

## Session log

Append one line per finished batch:
`<batch> — <date> — <commit> — <n edits, n unverified, n code bugs found>`
`A1 — 2026-08-21 — 77cdbe1.. — 13 edits, 0 unverified, 0 code bugs`
`A2 — 2026-08-21 — 02 + landing committed; the 03 / 03_lib_remote comment edits sit in the working tree with the operator's in-progress 03 redesign — 13 edits, 0 unverified, 0 code bugs`
`A3 — 2026-08-21 — see commit — 16 edits, 0 unverified, 2 code bugs`
`A4 — 2026-08-21 — see commit — 4 edits, 0 unverified, 0 code bugs`
`A5 — 2026-08-21 — see commit — 5 edits, 0 unverified, 0 code bugs`
`A6 — 2026-08-21 — see commit — 6 edits, 0 unverified, 0 code bugs`
