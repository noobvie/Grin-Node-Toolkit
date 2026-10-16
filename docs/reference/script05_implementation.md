# Script 05 — Wallet & Payment Services Hub: implementation

> **Covers code as of:** 2026-08-04 (the doc: "current as of 2026-08-04") · **Last verified:** never systematically verified
> **Product code last changed:** 2026-09-27 — `scripts/05_grin_wallet_service.sh` (CMD wallet `L) Listener` screen; that section and the 2026-09-25 Nuke section are current, the rest of the doc is still as of 2026-08-04)

**Status:** built. Sections 1.1–1.6 describe the hub as of 2026-08-04 (the 05x renumber + rename and the fixed-slot menu keys); the CMD wallet subsections are current as of 2026-09-27 and were exercised locally against stubs only — **not run on a VPS**.

This is the authoritative record for the 05 hub's numbering and menu behaviour. The hub's own
header comment in `scripts/05_grin_wallet_service.sh` carries the short form; this file carries
the reasoning and the open questions.

Companion docs: `script052_design.md` + `script052_implementation.md` (Accio — moved out of
`script05_design.md` PART A on 2026-08-09 when its build started) · `script05_design_goblin.md` ·
`script059_*.md` (Grin Drop — renamed from `script052_*`) · `script053_design.md`
(WooCommerce — did **not** move).

## What shipped

### 1.1 Number allocation — settled, do not reopen

| # | Product | Category | Status |
|---|---------|----------|--------|
| `05_` | Wallet Services Hub | — | built |
| `05C` | CMD Wallet Quick Setup | Wallets | built — hub-built, **no script file** |
| `051` | **Fidelius** — personal web wallet | Wallets | building |
| `051x` | **Grin XP** — Fidelius in a WinXP shell | Wallets | building — variant, not a separate number |
| `052` | **Accio** — public web wallet | Wallets | built 2026-08-09/10 (never VPS-run). Was the one reservation; claimed when its build started, so the band now holds none |
| `053` | WooCommerce Gateway | Payments | building |
| `054`–`058` | — | — | **FREE.** No product may claim one before its build starts |
| `059` | **Grin Drop** — giveaway + donation portal | Giveaways | built (moved from `052`) |

**An unbuilt product has no number.** Payment Pro and GoblinPay are *expected* to land at
`054`/`055` as they are built, but neither is assigned — their design content lives under the
hub's number (`script05_*.md`), never under a reserved one. Accio is the worked example: it
held `052` as a reservation until its build began on 2026-08-09, which is when the number became
an assignment and `script052_design.md` became a legitimate filename.

**`052` WAS the single exception**, and it needed a reason to survive that rule: freeing a wallet
slot next to `051` is the *only* thing the Drop migration bought. Letting anything else take it
would have meant paying for the migration and discarding what it was for. Accio's build start on
2026-08-09 spent the reservation on exactly what it was held for, so the 05 band now carries no
exception at all — `054`–`058` are plain unallocated numbers, and the toolkit's only live
reservation is `092` (mwixnet mixer) in the 09 band.

### 1.2 Menu keys — FIXED SLOTS

Each category owns a contiguous block of keys ending in a **spare**. A row owns its key
permanently. Planned and spare rows own theirs from the start.

| Key | Row | Dispatches to |
|-----|-----|---------------|
| `A` | CMD Wallet Quick Setup | `cmd_wallet_run` (hub-built) |
| `C` | *(not printed)* | `cmd_wallet_run` — **retired-key alias**, see 1.4 |
| `1` | Fidelius | `run_sub 051_grin_fidelius.sh` |
| `2` | Accio | `run_sub 052_grin_accio.sh` — since 2026-08-10 (packet S7); the `_slot_notice` arm is deleted, not aliased |
| `3` | Grin XP | `run_sub 051x_grin_xp_wallet.sh` |
| `4` | *Spare slot* | `_slot_notice` — unassigned |
| `5` | WooCommerce Gateway | `run_sub 053_grin_woocommerce.sh` |
| `6` | Payment Pro | `_slot_notice` — not built |
| `7` | GoblinPay | `_slot_notice` — not built |
| `8` | *Spare slot* | `_slot_notice` — unassigned |
| `9` | Grin Drop | `run_sub 059_grin_drop.sh` |
| `0` | Back to main menu | `break` |

Prompt string: `Select [A / 1-9 / 0]:`

> **The key is NOT the script number.** Key `5` is WooCommerce (`053`); key `9` is Grin Drop
> (`059`) and those two digits coincide **by accident**. That coincidence is exactly the
> confusion that prompted this change — do not "fix" a key to match a number, and do not read a
> number off a key.

**Three places must agree, and nothing checks that they do:**
1. the `echo` rows in `show_menu()`
2. the `case` arms in `main()`
3. the prompt string `Select [A / 1-9 / 0]`

Plus the status-overview block above the menu, which must stay in **menu order**
(Wallets → Payments → Giveaways). CMD Wallet is key `A` but prints **first**, because it is the
first row on screen. A comment above the block says to keep the two in step.

### 1.3 `_slot_notice()` — the planned/spare key contract

A planned or spare key is **live**. It dispatches to `_slot_notice()`, which prints one banner
screen — what the slot is for, an optional design-doc pointer, `Nothing was installed or
changed.` — and returns on Enter.

**It has no sub-menu and no prompts.** That is the whole design: it cannot be mistaken for the
"coming soon" placeholder script that was deleted, which was a fake product with options that
did nothing and which an operator could wander into and read as a broken install.

This is a deliberate reversal of the old rule *"never give a planned row a live key."* Under
fixed slots a **dead** key is worse: the number is printed on the row and sits inside the
`[A / 1-9 / 0]` hint, so falling through to "Invalid option" reads as a broken menu.

Ends on `read -r || true`, and uses the `if`-form for its optional doc line — a trailing
`[[ -n "$doc" ]] && echo …` would make the function return 1 and kill the menu loop under
`set -e`.

### 1.4 Retired key vs reassigned key

- A **retired** key — one nothing else took — may stay as a silent, unprinted alias, so muscle
  memory still lands somewhere sane. `C` still reaches the CMD wallet.
- A **reassigned** key never may. A second `case` arm for it is dead code (bash takes the first
  matching arm) and, if it were reachable, would open the wrong product with no error.

The move to fixed slots re-pointed `2` (WooCommerce → Accio), `3` (Drop → Grin XP), `5` and `9`
one final time. Those old meanings are gone and get **no alias**. The per-product banner
(`059) GRIN DROP`) is the mis-key safety net.

Fixed slots exist to end key churn, so this rule should now be history rather than a live risk.

### 1.5 Status detectors

Each row's "installed / running" state is probed independently — nothing reads a registry.

| Product | Installed — file probe | Running — liveness probe |
|---------|------------------------|--------------------------|
| CMD Wallet | `/opt/grin/cmdwallet/{mainnet,testnet}/grin-wallet.toml` | `tmux has-session grin_{mainnet,testnet}_cmd_wallet` |
| Fidelius (051) | `/opt/grin/fidelius/config.conf` | `systemctl is-active grin-fidelius` |
| Grin XP (051x) | `/opt/grin/webwallet/xp-mainnet/config.conf` | nginx symlink `sites-enabled/web-wallet-xp` |
| WooCommerce (053) | unit file `/etc/systemd/system/grin-wallet-bridge-{main,test}.service` | `systemctl is-active grin-wallet-bridge-{main,test}` |
| Grin Drop (059) | dir `/opt/grin/drop-{main,test}` | `systemctl is-active grin-drop-{main,test}` |

Note the **installed** probes are deliberately inconsistent in kind — a toml, a config file, a
unit file, a directory. Each product's setup writes something different first, so each detector
probes whatever that product's own setup guarantees. Don't unify them without checking what each
setup actually creates.

**Grin XP is mainnet-only by design**, so `_051x_status` returns a single label or nothing —
never a network pair. Its detectors were added when it was promoted to its own hub key; they
mirror the `_051_*` pair exactly, including the shared caveat below.

> **Known imprecision, inherited not introduced:** for 051 and 051x, "running" means *the nginx
> vhost is enabled*, not that the backend answers. A symlink can outlive a dead service. Drop and
> WooCommerce use systemd and do not have this gap. Worth tightening if a "running but broken"
> report ever appears.

### 1.6 Deployed-state keys — what a live server matches on

Two artifacts on a running box are keyed by the script **number**. They are *matching keys*, not
labels: the script greps for them to decide what is already installed. Both had to migrate with
the renumber.

**nginx** — `/etc/nginx/conf.d/script052-drop.conf` → `script059-drop.conf`

> The old file is deleted **before** the new one is written, in
> `059_lib_nginx.sh:_drop_write_unified_conf`. Order matters twice over: with both present the
> same `limit_req_zone` names are defined twice in the http context, nginx refuses to start and
> every later `systemctl reload nginx` fails — *and* `nginx_ensure_rate_limit_zones` skips its
> write when the zone already exists elsewhere, so write-first would make the rename silently
> never happen. nginx is not reloaded between the two, so the zones are never undefined.
> All three callers already `nginx -t &&` before reloading.

**cron** — tag `052_watchdog_<net>` → `059_watchdog_<net>`

> Detect **and** remove paths grep for **both** tags for one release (`059_grin_drop.sh` status +
> delete-everything sweep, `059_lib_wallet.sh` status + toggle). Without the dual grep an
> already-deployed box gets a duplicate watchdog and the old entry can never be removed. On an old
> box the first toggle removes the legacy entry rather than stacking a second one.
> The `@reboot` tag `# grin-drop-<net>-reboot` carries no number and was left alone.

Nothing else migrated: `/opt/grin/` paths, systemd units and the Drop database carry no number.
`051` had no deployed number-dependency at all, so its rename was purely files.

#### Fidelius service + path rename

`grin-web-wallet` → **`grin-fidelius`**, and `/opt/grin/webwallet/` → **`/opt/grin/fidelius/`**.
Done deliberately **before the first VPS deploy**, when it is a pure find-and-replace: once
installed it becomes a matched-key migration (stop/disable/rm the old unit before writing the
new one, rm the old vhost before the new one, move the htpasswd or make operators re-enter
credentials) — the same cost the Drop `052→059` move paid. `grin-web-wallet` was a *category*,
not a product, and the 05 band holds three web wallets.

`/opt/grin/webwallet/` was **not** Fidelius-only, which is why the move is partial: `051x` keeps
its config at `/opt/grin/webwallet/xp-mainnet/`. Moving a possibly-deployed product's config is
a migration in its own right and was deliberately not folded into this one, so the generic
directory now belongs to Grin XP alone.

The two `_051_*` detectors above were also **wrong before this** — they probed
`/opt/grin/webwallet/{mainnet,testnet}/config.conf` and the `web-wallet-{main,test}` symlinks,
both PHP-era paths that nothing has written since the Node port made Fidelius one instance
serving both networks (design D1). The hub row therefore read "not installed" on every current
deploy. Fixed alongside the rename, not by it.

#### Fidelius service log — location + rotation

The log moved `/var/log/grin-fidelius.log` → **`/opt/grin/logs/grin-fidelius.log`**, joining every
other toolkit daemon log. Beyond consistency (one directory to back up, clean and look in), it lets
the unit drop `/var/log` from `ReadWritePaths` — a root-run Node process no longer has write access
to the system log directory.

Three things that are easy to get wrong here:

| | |
|---|---|
| **`mkdir -p /opt/grin/logs` before start** | systemd's `append:` creates the *file* but never the *directory*. A missing dir fails the unit at start with an opaque exit code. |
| **Rotation must be `copytruncate`** | `append:` holds an open fd. A rename-and-create rotation would leave the daemon writing to the rotated inode forever and the fresh log permanently empty. Script 07 solves the same problem with a `USR2` reopen signal; `server.js` has no such handler. |
| **051 ships its OWN `/etc/logrotate.d/grin-fidelius`** | It does *not* join Script 08's toolkit list — 08's list is opt-in (Automatic Disk Cleanup), and the same path in two logrotate files errors with "duplicate log entry". 08's exclusion comment names `grin-fidelius.log` for the same reason. |

Rotation is `weekly`, `rotate 4`, `size 10M`, compressed. One consequence worth knowing when
debugging: **`journalctl -u grin-fidelius` never shows app output** — `append:` redirects stdout
away from the journal, so the journal carries only systemd's own start/stop/crash lines. The setup
screen prints both destinations.

#### CMD wallet (05C) — two listener modes

The CMD wallet ran `grin-wallet listen` only. Setup now asks which mode, stored in
`<dir>/.listen_mode`; `listen` stays the default and pre-existing wallets keep it.

| Mode | Command | Port | What it gives / costs |
|---|---|---|---|
| `listen` | `grin-wallet listen` | 3415/13415 | Foreign API only — receive-only. grin-wallet starts **Tor** for it, so the wallet gets an `.onion` for free. **No Owner API.** |
| `owner_api` | `grin-wallet owner_api` | 3420/13420 | Owner v3 **+** Foreign on one port (`owner_api_include_foreign`). Can be driven over HTTP. **No automatic Tor onion.** |

**Why it was added:** the Script 093 Transporter agent's send path is
`init_send_tx` → `tx_lock_outputs` → `finalize_tx` — all Owner API. Against a
`listen` wallet there is nothing to call, so the answer to "no wallet exists, run
the CMD wallet" was simply false until this landed. The alternative was a fifth
wallet-init implementation inside 093, which would also have meant a fifth seed
outside `grin_wallets_location.conf` — the exact hole that left Fidelius's seeds
out of every 089 archive.

Details that bite:

| | |
|---|---|
| **Mode parsing fails closed** | Anything that is not exactly `owner_api` reads as `listen`. An empty, missing or hand-edited mode file must never resolve to the mode that opens an Owner API. |
| **Every port guard uses `_cmd_mode_port`** | An `owner_api` wallet never binds 3415, so the old `_cmd_foreign_port` guard would have checked an unused port and let a real 3420 collision through. |
| **Both port keys are pinned, always** | `grin-wallet init` writes the mainnet default into `owner_api_listen_port` too, so an unpinned testnet wallet would try to bind 3420 the moment menu option 3 ("Both") puts an `owner_api` wallet on each network. |
| **`owner_api_include_foreign` is set, never unset** | It is inert while `listen` is active, so switching modes never has to undo a toml edit. |
| **Restart waits on the tmux session, not just the port** | After a mode switch the old listener holds the *old* port while the wait loop watches the *new* one — it reads "free" instantly and races the dying process for the wallet's LMDB lock, failing with a lock error that says nothing about a mode change. |

The trade is printed at the prompt and repeated in the summary. An operator who
only wants to receive slates by hand is strictly better off on `listen`.

#### CMD wallet (05C) — Nuke screen + Re-initialize fix

⚠ Built and exercised locally against a fake `grin-wallet` only — **not run on a VPS**.

**The bug.** Re-initialize deleted `<net>_pass_wallet.txt` / `<net>_seed.txt`, then ran
`init -h` over the old wallet. grin-wallet refuses that whenever the toml **and** `wallet_data/`
both exist (`create_config` → "… already exists in the target directory. Please remove it
first", `impls/src/lifecycle/default.rs` at v5.5.0). The success check only looked for the toml,
which the old wallet still had, so setup printed **"Wallet initialized."** with the old wallet
untouched — and then saved the *new* passphrase, which does not open it. The pass/seed files were
also deleted before the mode prompt, so cancelling there left a wallet with no saved passphrase.

**The fix** (`_cmd_retire_wallet`, shared with the new screen):

| | |
|---|---|
| **Every question first** | Mode, new passphrase and the mainnet typed confirm are all collected before anything on disk changes. A `0` at any of them still cancels with nothing touched. |
| **Success = the seed** | `wallet_data/wallet.seed`, never the toml — grin-wallet writes the toml (`create_config`) *before* the seed (`create_wallet`), so a failed init leaves a toml behind. |
| **Half-initialized dir** | toml present, no seed → reported as a failed earlier init and cleared without the "destroy" prompt; there is nothing in it to lose. |
| **Stop by cwd, not port** | `_cmd_stop_wallet` kills the tmux session, then any `grin-wallet` whose cwd is the wallet dir (TERM, then KILL), and refuses to touch disk if one survives. A foreign holder of 3415/3420 is still never killed. |
| **Mainnet is archived** | Testnet is deleted. Mainnet is **moved** to `/opt/grin/cmdwallet/.retired/mainnet-<ts>/` (700) and gated behind typing `MAINNET`. Purging it is a manual `rm -rf`. |
| **Keep-lists** | Re-init keeps `grin-wallet`, `.grin-wallet.version`, `.listen_mode`. Nuke keeps the first two unless the operator declines "keep binary"; then the whole dir goes. The binary store `/opt/grin/wallet-bin/` is never touched. |

**`N) Nuke wallet`** on the 05C screen: one network per run, shows what will go (seed present,
listener running, whether a saved seed exists), warns when a Transporter `agent.json` points into
the dir (it is **not** edited), removes the `CMDWALLET_<NET>_WALLET_DIR` line from
`grin_wallets_location.conf` so 089 stops collecting an empty dir, and prints restore/purge
commands for a mainnet archive. Setup re-registers on its next run.

Also fixed: the summary's "Listener started" line always printed the Foreign port; it now prints
the active mode and its port.

#### CMD wallet (05C) — `L) Listener` screen

⚠ Exercised locally against stubbed `tmux` / port helpers only — **not run on a VPS**.

Setup (1/2) used to be the only way to (re)start a listener, and it walks every prompt (binary,
init, passphrase, mode) before reaching it. `L` opens a per-network screen — straight in when only
one network has a wallet — with a status block (state, PID, uptime, mode, whether the passphrase is
saved) and four actions. It changes **no config**; mode, ports and the toml stay setup's job.

| Action | Calls | Note |
|---|---|---|
| Start | `_cmd_start_listener` | Refuses when already running (points at Restart) or when a `grin-wallet` with this cwd runs outside tmux. |
| Stop | `_cmd_stop_wallet` | Session + every `grin-wallet` whose cwd is the wallet dir; a foreign port holder is never touched. |
| Restart | `_cmd_stop_wallet` → `_cmd_start_listener` | Deliberately **not** the setup flow's kill-session-and-wait: stopping by cwd waits on the wallet's own PIDs. Without a saved passphrase it is asked *after* the stop. |
| Recent output | `tail` of `log_file_path` + `tmux capture-pane` | No attach needed — attaching and pressing Ctrl-C kills the listener. |

The status block adds the one state the 05C screen cannot show: a `grin-wallet` started by hand
from `listen.sh`, outside tmux. Start would otherwise fail the port guard ("held by ANOTHER
process") with no hint that the holder is this very wallet.


### Decisions (final)

#### Why Drop moved to `059` and not `054`

Giveaways is a one-member category. Parking it at the **end** of the band leaves a contiguous run
for the two categories that actually grow — wallets and payments — and costs **one** migration
instead of two: at `054`, WooCommerce would have had to move to `055` to keep Payments contiguous.
This way it does not move at all.

The "no headroom at the boundary" objection dissolves: the number encodes nothing about order
*within* a band. A second giveaway takes `058` and the band grows downward, with no menu
consequence, because the menu key is a fixed slot independent of the number.

#### Why not keep `052` and skip the whole migration

The Wallets category would stay permanently split around a giveaway faucet, and every future
wallet product would land further from `051`. This is the one-time cost that stops the question
being reopened.

#### Why fixed slots replaced positional keys

Positional keys (assigned top-to-bottom at render) stay ascending for free, but **every insertion
silently re-points every key below it.** That is how `2` came to mean Grin Drop and then
WooCommerce inside a single day.

**Accepted cost:** each category's spare is finite. When Wallets outgrows slot `4`, the next
wallet **cannot** take `5` — that is WooCommerce — so the blocks below shift in one deliberate
migration, done the way the `052 → 059` move was done. The trade is rare, explicit renumbering
instead of constant, invisible key drift.

Hubs `07` and `09` still assign keys positionally. Only hub `05` uses fixed slots.

#### Why readiness ordering was retired

The old rule sorted rows within a group ✅ ready → 🔧 building → planned. Under fixed slots a row
cannot move, and sorting by readiness would move a key **on the day a product ships** — exactly
what fixed slots exist to prevent. The `✅ / 🔧 / ⏳` marker carries readiness instead.

This is why `2) Accio ⏳` sits above `3) Grin XP 🔧`.

#### Menu category order

**Wallets → Accept Payments → Giveaways.** Without this, file order (`ls scripts/`) and menu order
stop matching, which is the main thing the renumber buys. It also reads fine on its own terms:
hold your own GRIN → take GRIN from customers → hand GRIN out.

#### Codenames — the wallets are Harry Potter named

`051` is **Fidelius** (the charm that hides a place so it cannot be found unless the Secret-Keeper
reveals it — a Tor hidden service with owner-only auth). `052` will be **Accio** (the Summoning
Charm).

Renamed because the old pair **inverted custody**: "Private Web Wallet" was the one where the
*server* holds the keys, and "Public Web Wallet" the one where keys never leave your device — so
anyone reasoning from the names got it backwards.

Ecosystem lineage to stay consistent with: Mimblewimble = Tongue-Tying Curse, Tom Elvis Jedusor =
French Voldemort, Ignotus Peverell = the Invisibility Cloak brother, Floonet = Floo Network;
Goblin/Grim/Ironbelly/Niffler already taken. Avoid WB's defended proper nouns (Gringotts,
Hogwarts, Muggle) — spell names and Latin words are safe.

The descriptor still rides in the dim subtitle. A bare codename on a menu row tells an operator
nothing, which is the same failure the numbers-are-internal rule exists to prevent.

#### Menu rows show NAMES, not numbers

`051 / 053 / 059 / 05C` are file and doc identity. They are **not** printed on menu rows — an
operator picking a wallet does not care which integer its script got, and two numbers per row
(`A) 05C ·`) read as a broken sequence.

The number **is** printed on each product's own screen banner (`059) GRIN DROP`), which is the
toolkit-wide convention. That is the one place it belongs — it tells you where you are after a
`clear` — and it is why the menu row can drop it without the number becoming unfindable.

Consequence: **never name a product to an operator by number alone.** Say "the CMD Wallet quick
setup (hub 05)", not "05C".

Digits and letters are two independent sequences: digits key products with their own script file,
letters key hub-built utilities that have none. That is why CMD Wallet is `A` and Fidelius is
still `1`, not `B`.

## Runbook

### Renaming or renumbering a product: the two sweeps
Run both over `scripts/ docs/ web/ README.md .claude/` after any rename; the second catches prose the first cannot.

```bash
# Prefixed forms — catches renamed files and paths
grep -rn "052_\|script052\|051_wallet\|051_grin_private" --include=*.sh --include=*.md --include=*.js \
  scripts/ docs/ web/ README.md .claude/ | grep -v node_modules

# Bare number — catches prose; the -vE strips hex-substring noise (RFC 6052, commit anchors)
grep -rn "052" --include=*.sh --include=*.md --include=*.js scripts/ docs/ web/ README.md .claude/ \
  | grep -v node_modules | grep -vE "[0-9a-f]{8,}"
```

Ground rules that held: `bash -n` every touched `.sh`; nothing under `/opt/grin/` is renamed (Drop's data carries no number); the old and new nginx conf / cron tag cannot coexist on a running server — the only part of a rename that can break one; WooCommerce (053) does not move.

## Build notes — obstacles & lessons

The migration log this section replaces (Phases 1–6 of the Drop `052 → 059` move, 2026-08-04): `git log -- docs/reference/script05_implementation.md`, the commit before the G7 re-org (2026-10-13).

### Renames and renumbers

#### The reference sweep must reach outside the product family
**Symptom:** the Drop move had four references outside the 05 family that an 05-scoped sweep would have missed — `089_backup_restore.sh`, `lib/grin_backup_push.sh`, the 093 `agent.js` and the pool's `lib/wallet.js` — and two cross-product comments (pool `index.js`, `lib/wallet.js`) named the old Fidelius directory and would have been missed by a 05-scoped sweep. **Fix:** sweep the whole repo with an explicit file list, memory files included. **Lesson:** a sweep scoped to the product's own directory misses the products that mention it.

#### `.claude/commands/` carries live paths, and nobody sweeps it
**Symptom:** `/research` pointed at two dead Drop files and `/web` at `web/052_drop/app/`; a stale command path fails silently at use time instead of reading as out-of-date prose. **Cause:** the reference table named `.claude/CLAUDE.md` specifically, so the sweep never widened to the sibling files. **Lesson:** sweep `.claude/` as a directory.

#### A path grep proves a reference resolves, never that the sentence around it is true
**Symptom:** `/web` labelled `web/051_fidelius/` as PHP although it contains no `.php` file — Express plus a JS client, always. **Cause:** the rename changed the directory only, and the grep matched the path, not the language. **Lesson:** read the surrounding claim, or the reviewer checks a Node service against `csrf.php` rules.

#### A prefixed grep misses bare-number prose
`052_` and `script052` do not match "052 Grin Drop". Run both patterns (Runbook). Strip hex-substring noise (`RFC 6052`, commit anchors) from the bare-number one.

#### Old and new deployed state cannot coexist
**Symptom (avoided):** a duplicate watchdog and a legacy entry that could never be removed. **Cause:** the cron tag and the nginx zone file carry the number. **Fix:** detect-and-remove paths grep for both tags for one release; the old nginx conf is removed before the new one is written. **Lesson:** before renaming, list every deployed identifier that embeds the number; the `@reboot` tag and `/opt/grin/` paths carried none and were left alone.

#### A table contradicted its own rule
**Symptom:** the allocation table listed `054 Payment Pro` / `055 GoblinPay` six lines above the rule "an unbuilt product has no number". **Fix:** resolved rather than copied — the header records `054–058 FREE` and names both as *expected* without assigning them. **Lesson:** when a table and a rule disagree, fix the one that is wrong; do not copy both.

#### Positional menu keys re-pointed within hours
Phase 3 let positional keys renumber (WooCommerce `3 → 2`, Drop `2 → 3`) and was replaced the same day by the fixed-slot map, which re-pointed `2`, `3`, `5` and `9` once more. **Lesson:** this is why keys are fixed slots (see *Decisions*): every insertion silently re-points every key below it. No compatibility aliases were added for reassigned keys — a single-user toolkit, with the per-product banner as the mis-key safety net.

### Hub detectors and the CMD wallet

#### Hub rows read "not installed" on every current deploy
**Symptom:** the Fidelius row was dark on a working install. **Cause:** `_051_installed` / `_051_status` probed PHP-era `config.conf` paths and `web-wallet-{main,test}` symlinks that nothing had written since the Node port made Fidelius one instance serving both networks. **Fix:** probe `config.conf` plus `systemctl is-active grin-fidelius`. **Lesson:** a detector keyed on a path outlives the layout that created it; "running" for 051/051x is still only an nginx symlink (Open items).

#### Re-initialize reported success over the old wallet
**Symptom:** setup printed "Wallet initialized." with the old wallet untouched, then saved a new passphrase that does not open it. **Cause:** grin-wallet refuses `init -h` when the toml and `wallet_data/` both exist; the success check looked only at the toml, which the old wallet still had; the pass and seed files were deleted before the mode prompt, so cancelling left a wallet with no saved passphrase. **Fix:** every question first, success = `wallet_data/wallet.seed` (grin-wallet writes the toml before the seed, so a failed init leaves a toml), a toml without a seed is a failed earlier init and is cleared without the destroy prompt, mainnet is archived not deleted (details in *What shipped*). **Lesson:** test the artifact written last, not first; collect every answer before touching disk.

#### Restarting on the port alone races the dying listener
**Symptom:** after a mode switch the restart failed with an LMDB lock error that said nothing about a mode change. **Cause:** the old listener still held the *old* port while the wait loop watched the *new* one, so it read "free" at once and raced the dying process for the wallet's lock. **Fix:** wait on the tmux session, and stop by cwd (the wallet's own PIDs) rather than by port; a foreign port holder is never killed. **Lesson:** a port is not an identity.

#### An unpinned testnet wallet binds the mainnet owner port
**Cause:** `grin-wallet init` writes the mainnet default into `owner_api_listen_port` as well. **Fix:** both port keys are pinned always; every port guard uses `_cmd_mode_port`, because an `owner_api` wallet never binds 3415 and the old foreign-port guard would have let a real 3420 collision through. `owner_api_include_foreign` is set, never unset (inert under `listen`), so switching modes never undoes a toml edit; mode parsing fails closed to `listen`.

#### Service log: `copytruncate` and `mkdir -p`
Moving the Fidelius log under `/opt/grin/logs` needs `mkdir -p` before start (systemd `append:` creates the file, not the directory) and `copytruncate` rotation (the fd stays open). Full entry: `script051_implementation.md` · Build notes.

## Open items


### Pending

| # | Item | Blocking | Notes |
|---|------|----------|-------|
| 1 | **Is "Payment Pro" the same product as "GrinPay Server"?** | Decide before *either* build starts | The 05 hub header describes Payment Pro as Shopify + custom REST + subscriptions; `script053_design.md` §16 describes GrinPay Server as REST + webhooks + multi-merchant. These may be one product under two names. Whichever survives takes the next free number. |
| 3 | **051/051x "running" = nginx symlink**, not a live backend | — | See §1.5. Tighten if a "running but broken" report appears. |
| 4 | **Drop wallet passphrase still passed via `-p`** | — | `059_lib_wallet.sh` reboot-cron + watchdog wrappers build `-p "$(cat …)"`, putting the passphrase in `ps aux` for the listener's whole life. CLAUDE.md flags this file as "still on `-p`, convert when next touched". The renumber touched adjacent lines without converting — a behaviour change out of scope for a rename, but the trigger has arguably fired. |
| 5 | **Dual cron-tag handling is a one-release measure** | — | The `052_watchdog_*` legacy greps in `059_grin_drop.sh` and `059_lib_wallet.sh` should be removed once no box carries the old tag. |
| 6 | **Legacy nginx zone-file cleanup** | — | The `rm` of `script052-drop.conf` can be dropped at the same time as #5. |
| 7 | **Other hubs have disordered keys** | Out of scope | Main menu prints `9` (Connectivity Hub) before `8` (Admin & Maintenance) — verified in `grin-node-toolkit.sh`; plus letter-key disorder in `06`, `03`, `02`, `04`, `051x`. A separate job — fixed slots were adopted for hub `05` only. |

