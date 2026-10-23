# Grin Node Toolkit — Claude Instructions

## Project Overview
A unified bash toolkit for deploying and managing Grin cryptocurrency nodes and
infrastructure on Linux servers (Debian/Ubuntu, Rocky Linux, AlmaLinux 10+).
Run as root/sudo on a remote VPS — **not executed locally on this machine.**

## Scope of this file — keep it lean
This file is loaded into EVERY session, so it holds only the rules most tasks need. Topic
detail lives in `.claude/context/` (committed — travels with the repo to any machine).
**Read the matching file before working in that area:**

| Working on… | Read first |
|---|---|
| a script number, a new product, 052 Accio, 07 pool roles, 09 band | `.claude/context/script_numbering.md` |
| a hub menu (keys, slots, retired keys, row labels) | `.claude/context/menus.md` |
| writing a lib, a menu loop, errexit questions | `.claude/context/bash_conventions.md` |
| node/wallet API calls, secrets, vault, passphrases, archive vs pruned, pool ports | `.claude/context/grin_node_api.md` |
| starting/stopping a node, tmux, cron | `.claude/context/node_launch.md` |
| nginx vhosts, rate-limit zones, certbot | `.claude/context/nginx.md` |
| writing/moving any `.md` or comment, `docs/reference/`, plans, temp files, local test servers | `.claude/context/docs_and_files.md` |

**Maintenance rule:** new toolkit-wide detail goes into the matching `.claude/context/` file (or a
new one + a row above); add a line HERE only if nearly every task needs it. Product detail goes
to `docs/reference/script##_*.md` (index `docs/reference/README.md`) and local memory
(`memory/`, indexed in `MEMORY.md`). ⚠ Local memory exists only on this PC — anything that must
survive a machine switch belongs in the repo.

## Tech Stack
- **Shell:** Bash (primary — all scripts must pass `bash -n`)
- **Web backend:** Node.js/Express + SQLite (053, 059, Script 07 pool backend)
- **Web server:** Nginx (vhosts, SSL via certbot) · **Processes:** systemd + tmux
- **Grin tooling:** grin-wallet (Foreign API v2, Owner API v3 ECDH). "Grim wallet" (GetGrin/grim)
  is a separate GUI wallet — never conflate it with grin-wallet.
- **Other:** Python 3 (stats/price collectors), tor, ufw/iptables

## Script Numbering (summary — full notes in `.claude/context/script_numbering.md`)
```
grin-node-toolkit.sh  Main menu
01_ Build node · 02_ Nginx file server · 03_ Share chain data · 04_ Node foreign API + stats
05_ Wallet services hub → 051_ Fidelius (keys server-side) · 052_ Accio (self-custodial,
    in build, NEVER run on a VPS) · 053_ WooCommerce · 054–058 FREE · 059_ Grin Drop
06_ Health + price collector (06b GrinScan) · 07_ Mining hub (solo + public pool)
08_ Node admin centre · 08del_ Full cleanup · 09_ Connectivity hub (091 Floonet,
    092 RESERVED mixer, 093 Transporter)
lib/ Sourced libraries, prefixed with the parent script number (059_lib_wallet.sh)
```
- Assign a number when a build STARTS, never to an idea. Never renumber a deployed product.
- **Never edit `web/052_accio/vendor/`** or an `ACCIO PATCH` marker.

## Common Commands
```bash
bash -n scripts/059_grin_drop.sh                                        # one script
for f in scripts/**/*.sh scripts/*.sh; do bash -n "$f" && echo "OK: $f"; done
for f in scripts/lib/*.sh; do bash -n "$f" && echo "OK: $f"; done
grep -n "function_name" scripts/*.sh scripts/lib/*.sh
```

## Conventions
- Scripts use `set -euo pipefail` at the top.
- **Menu loops under `set -e`:** every `case` dispatch MUST be `||`-guarded (`fn || true`).
  Never end a function with `[[ ... ]] && cmd` — use the `if`-form.
- **⚠ A function called as `fn || …` or `if fn; then` runs with errexit DISABLED** for its
  whole body, so every sourced lib effectively runs without `set -e`. In `lib/`, guard every
  create/copy/move/delete with its own `|| { error "..."; return 1; }`. A bare `cp`/`mv` in a
  lib is a silent failure (memory `project_lib_errexit_suppression`).
- Colors/logging defined once in the main script, inherited via `source`.
- Config → `/opt/grin/<service>/`; wallet secrets → `/opt/grin/<net>/.api_secret` (never hardcode).
- Testnet and mainnet always on separate ports/dirs.
- Lib files are sourced — no shebang. Functions `snake_case` with the script prefix (`drop_`, `node_`).
- Menus: numeric keys for main actions, letters for secondary; rows show NAMES, never script
  numbers. Key rules differ per hub → `.claude/context/menus.md` before touching a menu.
- Session logs `_$(date +%Y%m%d_%H%M%S).log`; continuous logs rotate via logrotate.
- **Comments state what is true NOW and why** — no plan tags (`Part N`, `S3 packet`), no diary
  ("was X, now Y"), dates only as evidence, pointers must resolve, no commented-out code
  without a reason. Checked by `docs/tools/check_comments.js scan`; a comment-only change must
  pass `diffgate`. A comment inside a heredoc is VPS file content, i.e. behaviour.

## Grin Network Details

| | Mainnet | Testnet |
|---|---|---|
| CLI flag | *(none)* | `--testnet` |
| Currency label | `GRIN` | `tGRIN` |
| P2P port | 3414 | 13414 |
| Node API port | 3413 | 13413 |
| Node API (nginx) | `https://api.grin.money` | `https://testapi.grin.money` |
| Wallet Foreign API | 3415 | 13415 |
| Wallet Owner API | 3420 | 13420 |
| Node stratum (grin default, not moved) | 3416 | 13416 |

Node dirs: `/opt/grin/node/<net>-prune/` (archive: `<net>-full/`). Pool ports → `.claude/context/grin_node_api.md`.

**Node API essentials** (full detail → `.claude/context/grin_node_api.md`):
- **There is NO `/v1/` API** — it 404s on a healthy node and reads as an outage. Use `/v2/owner`
  (`get_status`, preferred over `get_tip`) or `/v2/foreign` (`get_tip`, `get_block`, …).
- Results are `{"Ok": T}` / `{"Err": E}` inside `result` — always unwrap; reachability needs a
  parsed `Ok`, never just HTTP 200.
- Resolve node dirs/secrets via `scripts/lib/grin_node_secrets.sh`, never re-derive them.
- Feed grin-wallet passphrases on **stdin**, never `-p` (argv leaks via `ps`).
- Start/stop nodes only through `scripts/lib/grin_node_control.sh` (`gnc_*`), as `grin`.
- tmux from cron: always `SHELL=/bin/bash tmux new-session …`.
- Nginx rate-limit zones only via `scripts/lib/nginx_shared_helpers.sh`; `nginx -t` before reload.

**Hashrate (Cuckatoo32):** `GPS = diff_delta × 42 / block_time_seconds / 16384` — never
`difficulty / 60` (~366× too high). Units G/s, kG/s (≥1 000), MG/s (≥1 000 000).

## Docs & temp files (full rules → `.claude/context/docs_and_files.md`)
- Generated docs go to `docs/reference/` as `script<XX>_<type>[_service][_date].md`; add a row
  to `docs/reference/README.md`. Session plans go to `D:/tmp/grin-toolkit-plans/`, never the repo.
- Never write a `Last verified` date you did not verify.

## Local Test Processes — Kill Everything You Start
The dev machine is the user's single Windows workstation. Prefer one-shot checks; if a server
is unavoidable bind `127.0.0.1`, capture the PID and kill the whole tree in the same session
(background tasks too). Sweep before ending — detail and the sweep command →
`.claude/context/docs_and_files.md`. Never kill `msedge`/`chrome`/`Code`.

## Per-Product Detail — pointers (not in this file)
Deep implementation facts live in local memory + committed docs. When working on a product,
recall the relevant memory and read its doc:
- **Script 07 public mining pool** (architecture, locked design decisions, admin panel, CMS,
  multi-region hub + thin stratum gateways, payments) → memory `project_pool_*` + `docs/reference/script07_*.md`.
  The pool lives in THIS repo (`scripts/07_grin_mining_public_pool.sh` + `web/07_mining_pool_public/`);
  the standalone GRINIUM repo is **deprecated — never edit it**.
  Backend routes live in `back-end-pool/routes/` (one file per area, `index.js` is boot only); pages carry no
  inline script and `script-src` has no `'unsafe-inline'` — see impl §12 "Code layout".
- **GrinScan / grin-explorer (06b), pruned vs archive runtime behaviour** → memory `project_grinscan_archive_lazy`.
- **Solo mining** (block-finder attribution, SQLite collector) → memory `project_testnet_solo_mining`, `project_solo_sqlite_storage`, `project_solo_block_finder`.

## Debugging — Confirm Root Cause Before Editing
(Full text → `.claude/context/bash_conventions.md`.)
Confirm the cause with evidence before changing code. Ask the operator for diagnostics, make
sure each one can actually observe what it claims to, rule out environment differences, then
make the smallest fix at the true source.

## Do Not
- Never run toolkit scripts locally — they assume a Linux VPS with root access
- Never hardcode wallet API secrets or passwords
- Never skip `bash -n` before committing a shell script change
- Never use `--floonet` — the testnet flag is `--testnet`
- Never mix mainnet and testnet ports or directories
- Don't add `#!/bin/bash` to lib files
- Never leave a local test process running; never bind a test server to `0.0.0.0`/`::`
