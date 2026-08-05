# Script 05 — Wallet & Payment Services Hub — implementation record

**Status: current as of 2026-08-04.** Two changes landed the same day and this document covers
both: the **05x renumber + rename** (Grin Drop `052 → 059`, Fidelius/Accio codenames) and,
immediately after it, the **fixed-slot menu keys** that replaced positional keys.

This is the authoritative record for the 05 hub's numbering and menu behaviour. The hub's own
header comment in `scripts/05_grin_wallet_service.sh` carries the short form; this file carries
the reasoning and the open questions.

Companion docs: `script05_design.md` (PART A = Accio) · `script05_planning_goblin.md` ·
`script059_*.md` (Grin Drop — renamed from `script052_*`) · `script053_planning.md`
(WooCommerce — did **not** move).

---

# PART 1 — CURRENT STATE (technical spec)

## 1.1 Number allocation — settled, do not reopen

| # | Product | Category | Status |
|---|---------|----------|--------|
| `05_` | Wallet Services Hub | — | built |
| `05C` | CMD Wallet Quick Setup | Wallets | built — hub-built, **no script file** |
| `051` | **Fidelius** — personal web wallet | Wallets | building |
| `051x` | **Grin XP** — Fidelius in a WinXP shell | Wallets | building — variant, not a separate number |
| `052` | **Accio** — public web wallet | Wallets | **RESERVED, unbuilt** — the only reservation |
| `053` | WooCommerce Gateway | Payments | building |
| `054`–`058` | — | — | **FREE.** No product may claim one before its build starts |
| `059` | **Grin Drop** — giveaway + donation portal | Giveaways | built (moved from `052`) |

**An unbuilt product has no number.** Payment Pro and GoblinPay are *expected* to land at
`054`/`055` as they are built, but neither is assigned — their design content lives under the
hub's number (`script05_*.md`), never under a reserved one.

**`052` is the single exception**, and it needs a reason to survive that rule: freeing a wallet
slot next to `051` is the *only* thing the Drop migration bought. Letting anything else take it
would mean paying for the migration and discarding what it was for.

## 1.2 Menu keys — FIXED SLOTS

Each category owns a contiguous block of keys ending in a **spare**. A row owns its key
permanently. Planned and spare rows own theirs from the start.

| Key | Row | Dispatches to |
|-----|-----|---------------|
| `A` | CMD Wallet Quick Setup | `cmd_wallet_run` (hub-built) |
| `C` | *(not printed)* | `cmd_wallet_run` — **retired-key alias**, see 1.4 |
| `1` | Fidelius | `run_sub 051_grin_fidelius.sh` |
| `2` | Accio | `_slot_notice` — not built |
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

## 1.3 `_slot_notice()` — the planned/spare key contract

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

## 1.4 Retired key vs reassigned key

- A **retired** key — one nothing else took — may stay as a silent, unprinted alias, so muscle
  memory still lands somewhere sane. `C` still reaches the CMD wallet.
- A **reassigned** key never may. A second `case` arm for it is dead code (bash takes the first
  matching arm) and, if it were reachable, would open the wrong product with no error.

The move to fixed slots re-pointed `2` (WooCommerce → Accio), `3` (Drop → Grin XP), `5` and `9`
one final time. Those old meanings are gone and get **no alias**. The per-product banner
(`059) GRIN DROP`) is the mis-key safety net.

Fixed slots exist to end key churn, so this rule should now be history rather than a live risk.

## 1.5 Status detectors

Each row's "installed / running" state is probed independently — nothing reads a registry.

| Product | Installed — file probe | Running — liveness probe |
|---------|------------------------|--------------------------|
| CMD Wallet | `/opt/grin/cmdwallet/{mainnet,testnet}/grin-wallet.toml` | `tmux has-session grin_{mainnet,testnet}_cmd_wallet` |
| Fidelius (051) | `/opt/grin/webwallet/{mainnet,testnet}/config.conf` | nginx symlink `sites-enabled/web-wallet-{main,test}` |
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

## 1.6 Deployed-state keys — what a live server matches on

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
`051` had no deployed number-dependency at all (its unit is `grin-web-wallet.service`), so its
rename was purely files.

---

# PART 2 — DECISIONS (final)

### Why Drop moved to `059` and not `054`

Giveaways is a one-member category. Parking it at the **end** of the band leaves a contiguous run
for the two categories that actually grow — wallets and payments — and costs **one** migration
instead of two: at `054`, WooCommerce would have had to move to `055` to keep Payments contiguous.
This way it does not move at all.

The "no headroom at the boundary" objection dissolves: the number encodes nothing about order
*within* a band. A second giveaway takes `058` and the band grows downward, with no menu
consequence, because the menu key is a fixed slot independent of the number.

### Why not keep `052` and skip the whole migration

The Wallets category would stay permanently split around a giveaway faucet, and every future
wallet product would land further from `051`. This is the one-time cost that stops the question
being reopened.

### Why fixed slots replaced positional keys

Positional keys (assigned top-to-bottom at render) stay ascending for free, but **every insertion
silently re-points every key below it.** That is how `2` came to mean Grin Drop and then
WooCommerce inside a single day.

**Accepted cost:** each category's spare is finite. When Wallets outgrows slot `4`, the next
wallet **cannot** take `5` — that is WooCommerce — so the blocks below shift in one deliberate
migration, done the way the `052 → 059` move was done. The trade is rare, explicit renumbering
instead of constant, invisible key drift.

Hubs `07` and `09` still assign keys positionally. Only hub `05` uses fixed slots.

### Why readiness ordering was retired

The old rule sorted rows within a group ✅ ready → 🔧 building → planned. Under fixed slots a row
cannot move, and sorting by readiness would move a key **on the day a product ships** — exactly
what fixed slots exist to prevent. The `✅ / 🔧 / ⏳` marker carries readiness instead.

This is why `2) Accio ⏳` sits above `3) Grin XP 🔧`.

### Menu category order

**Wallets → Accept Payments → Giveaways.** Without this, file order (`ls scripts/`) and menu order
stop matching, which is the main thing the renumber buys. It also reads fine on its own terms:
hold your own GRIN → take GRIN from customers → hand GRIN out.

### Codenames — the wallets are Harry Potter named

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

### Menu rows show NAMES, not numbers

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

---

# PART 3 — PENDING / OPEN

| # | Item | Blocking | Notes |
|---|------|----------|-------|
| 1 | **Is "Payment Pro" the same product as "GrinPay Server"?** | Decide before *either* build starts | The 05 hub header describes Payment Pro as Shopify + custom REST + subscriptions; `script053_planning.md` §16 describes GrinPay Server as REST + webhooks + multi-merchant. These may be one product under two names. Whichever survives takes the next free number. |
| 2 | **Accio is unbuilt** and holds `052` | — | Design → `script05_design.md` PART A. Being refactored from MWC-Wallet-Standalone, **not** a fresh `wasm-pack` build — the design doc still says otherwise and needs correcting. |
| 3 | **051/051x "running" = nginx symlink**, not a live backend | — | See §1.5. Tighten if a "running but broken" report appears. |
| 4 | **Drop wallet passphrase still passed via `-p`** | — | `059_lib_wallet.sh` reboot-cron + watchdog wrappers build `-p "$(cat …)"`, putting the passphrase in `ps aux` for the listener's whole life. CLAUDE.md flags this file as "still on `-p`, convert when next touched". The renumber touched adjacent lines without converting — a behaviour change out of scope for a rename, but the trigger has arguably fired. |
| 5 | **Dual cron-tag handling is a one-release measure** | — | The `052_watchdog_*` legacy greps in `059_grin_drop.sh` and `059_lib_wallet.sh` should be removed once no box carries the old tag. |
| 6 | **Legacy nginx zone-file cleanup** | — | The `rm` of `script052-drop.conf` can be dropped at the same time as #5. |
| 7 | **Other hubs have disordered keys** | Out of scope | Main menu prints `9` (Connectivity Hub) before `8` (Admin & Maintenance) — verified in `grin-node-toolkit.sh`; plus letter-key disorder in `06`, `03`, `02`, `04`, `051x`. A separate job — fixed slots were adopted for hub `05` only. |

**Closed 2026-08-04:** `.claude/settings.local.json` carried 13 dead permission entries naming
`052_grin_drop.sh` / `web/052_drop/…`. They were non-functional (referencing files that no longer
exist, so they could never match) and have been removed. The file is gitignored, so the change
does not appear in `git status`.

---

# PART 4 — MIGRATION RECORD (history)

All phases executed 2026-08-04. Kept for the lessons, not as a work list.

**Line numbers and paths in this section are written as they were *before* that phase ran.** The
hub header grew ~40 lines in Phase 4 and ~70 more in the fixed-slot change, so every line number
quoted below has moved.

### Phase 1+2 — Grin Drop `052 → 059` (one atomic change)

10 logical items `git mv`d so history follows — **39 tracked files** in total: `052_grin_drop.sh`,
five `lib/052_lib_*.sh`, three `docs/generated/script052_*.md` (9 named files), plus the whole
`web/052_drop/` tree (30 files). Deployed-state migration as in §1.6.

Reference sweep reached **outside** the 05 family — the four easily missed:
`scripts/089_backup_restore.sh`, `scripts/lib/grin_backup_push.sh`,
`web/093_transporter/client/agent.js`, `web/07_mining_pool_public/back-end-pool/lib/wallet.js`.
Local memory was updated too (`project_drop_backup_052.md` → `_059.md`, plus stale
`052_lib_*.sh` pointers in five other memory files).

### Phase 3 — menu reorder *(superseded within hours — see PART 1)*

Moved Giveaways below Accept Payments and let positional keys renumber: WooCommerce `3 → 2`,
Drop `2 → 3`, prompt `Select [A / 1-3 / 0]`. **This state no longer exists.** The fixed-slot
change replaced it the same day with the 1-9 map in §1.2, and re-pointed `2`, `3`, `5` and `9`
one final time.

### Phase 4 — record the allocation

Header blocks added to `scripts/05_grin_wallet_service.sh`; one-line summary mirrored into
`.claude/CLAUDE.md`.

One conflict surfaced and was **resolved rather than copied**: the decision table listed
`054 Payment Pro` / `055 GoblinPay`, but the rule six lines below said an unbuilt product has no
number. The header now records `054–058 FREE`, names both as *expected* at 054/055 without
assigning them, and states that `052` is the only reservation — with the reason it survives the
rule.

### Phase 5 — Fidelius filename

`051_grin_private_web_wallet.sh` → `051_grin_fidelius.sh`, `web/051_wallet/` → `web/051_fidelius/`.
No deployed dependency (verified, not assumed: the detectors probe config files and nginx symlinks,
none of which carry the filename).

- The old filename appeared in **two capitalisations** (`Generated` / `generated`) across the
  header, two nginx heredocs and the `wallet.env` heredoc — a single case-sensitive pass misses one.
- Two cross-product comments outside the 05 family named the old dir and would have been missed by
  an 05-scoped sweep: `07_mining_pool_public/back-end-pool/index.js` (trust-proxy convention) and
  `lib/wallet.js` (ECDH reference implementation).
- `051x_grin_xp_wallet.sh` keeps its name — it is a variant of 051, not a separate number.

### Phase 6 — final sweep

Caught one directory the reference table missed: **`.claude/commands/`**. The table named
`.claude/CLAUDE.md` specifically, so the sweep never widened to the sibling command files — and
those carry live paths that agents **open**, so a stale one fails silently at use time rather than
reading as out-of-date prose. `/research` pointed at two dead Drop files; `/web` at
`web/052_drop/app/`.

> **Sweep `.claude/` as a directory, not just `CLAUDE.md`.**

**The two lessons worth keeping:**

1. **A path grep verifies that a reference *resolves*, never that the sentence around it is still
   true.** A self-review found `/web` labelling `web/051_fidelius/` as **PHP** when it contains
   zero `.php` files — it is Express + a JS client, and always was. Phase 5 only renamed the
   directory, so the wrong label predated the plan and survived because the grep matched the
   *path*, not the language. Fixing the neighbouring heading and leaving that one would have left
   `/web` reviewing a Node service against `echo $_POST` and `csrf.php` rules. **Read the
   surrounding claim.**

2. **A prefixed grep misses bare-number prose.** `052_` / `script052` don't match "052 Grin Drop".
   Use both patterns:

```bash
# Prefixed forms — catches renamed files and paths
grep -rn "052_\|script052\|051_wallet\|051_grin_private" --include=*.sh --include=*.md --include=*.js \
  scripts/ docs/ web/ README.md .claude/ | grep -v node_modules

# Bare number — catches prose; the -vE strips hex-substring noise (RFC 6052, commit anchors)
grep -rn "052" --include=*.sh --include=*.md --include=*.js scripts/ docs/ web/ README.md .claude/ \
  | grep -v node_modules | grep -vE "[0-9a-f]{8,}"
```

### Ground rules that held throughout

1. `bash -n` every touched `.sh` before finishing. Hard rule, no exceptions.
2. **Nothing under `/opt/grin/` is renamed** — Drop's data (`drop-main/`, `drop-test/`,
   `drop-<net>-data/`) carries no number. The DB in particular was never touched.
3. `052` was not reusable until Phase 2 completed, because three `script052_*.md` docs described
   Grin Drop.
4. The nginx conf and cron tag **cannot coexist** in old and new form — the only part of the job
   that can break a running server.
5. **WooCommerce (053) does not move.** If you find yourself renaming it, stop and re-read §1.1.

### What the migration deliberately did not do

- Did not touch the other hubs' key ordering (PART 3 #7).
- Did not renumber WooCommerce.
- Did not migrate any `/opt/grin/` path, systemd unit or database.
- **Did not add compatibility aliases for reassigned keys.** Single-user toolkit; old keys simply
  change, and the per-product banner is the safety net for a mis-key.
