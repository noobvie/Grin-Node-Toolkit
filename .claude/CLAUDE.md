# Grin Node Toolkit — Claude Instructions

## Project Overview
A unified bash toolkit for deploying and managing Grin cryptocurrency nodes and
infrastructure on Linux servers (Debian/Ubuntu, Rocky Linux, AlmaLinux 10+).
Run as root/sudo on a remote VPS — **not executed locally on this machine.**

## Scope of this file
CLAUDE.md holds **general Grin architecture + toolkit-wide conventions only.**
Product-specific implementation detail (Script 07 pool internals, GrinScan, solo
mining, admin panel, CMS, etc.) lives in **local memory** (`memory/` dir, indexed in
`MEMORY.md`) and in committed **`docs/generated/script##_*.md`**. The user runs a single
Windows + VSCode machine, so local memory is durable — write reusable product facts there,
keep this file lean. (The full pre-2026-06 product detail is recoverable from git history.)

## Tech Stack
- **Shell:** Bash (primary — all scripts must pass `bash -n` syntax check)
- **Web backend:** Node.js/Express + SQLite (scripts 053+059, and the Script 07 public-pool backend)
- **Web server:** Nginx (vhost management, SSL via certbot)
- **Process management:** systemd services + tmux sessions
- **Grin tooling:** grin-wallet binary (Foreign API v2, Owner API v3 ECDH). **Note:** "Grim wallet" (GetGrin/grim) is a completely separate GUI wallet project — never conflate with grin-wallet (mimblewimble org).
- **Other:** Python 3 (stats/price collectors), tor, ufw/iptables

## Script Numbering Convention
```
grin-node-toolkit.sh     Main menu entry point
scripts/
  01_  Build new Grin node (chain sync, binary install)
  02_  Nginx file server manager
  03_  Share chain data
  04_  Node foreign API + stats collector
  05_  Wallet services hub (launches 051–059; also hosts the 05C CMD-wallet quick setup)
  051_ Fidelius — personal web wallet (051x_ = XP-themed variant; has its OWN hub key
       since 2026-08-04, and is still reachable from inside 051)
  052_ Accio — public web wallet. IN BUILD since 2026-08-09 (packet S0), so it is
       no longer "reserved" — the number is ASSIGNED and the script file exists.
       **EVERY packet through S8 is written and EVERY menu key is live** (the last
       stub went 2026-08-10), and hub 05 key `2` now dispatches to the real script.
       S9's optional deletion passes started 2026-08-11 (pass 1 = MQS).
       ⚠ **Nothing has ever run on a VPS** — not one build, deploy, send or receive.
       S2 is no longer a build packet at all: it is the ACCEPTANCE session and owes
       every packet's runs at once, testnet before mainnet. A menu with no stubs is
       not a tested one. Self-custodial (keys in the browser
       tab) — the exact opposite of 051, which holds keys server-side. Vendored, not
       written: web/052_accio/vendor/ pins two MIT upstreams; the gateway
       (web/052_accio/gateway/, 9 modules, ZERO npm deps) is ours and carries both
       rails — /tor/ out, /listen + /wallet/<suffix> in. Four libs: build (site +
       the offline standalone HTML), gateway, nginx (vhost/certbot/onion), vendor.
       ⚠ nginx security headers live in TWO snippets (shared, and TLS-only for the
       headers the onion front must NOT emit) that every block adding any header of
       its own must include — `add_header` in a child block DISCARDS the parent's
       set, which is how a CSP goes missing from exactly the routes that matter, and
       a header repeated as a literal in three blocks is how the next one goes
       missing. And minting the onion is not enough: TOR_SERVER_ADDRESS is baked in
       at BUILD time, so an un-rebuilt site hands out a clearnet host to whoever
       picked "Onion Service". ⚠ The onion path is THREE listeners and so needs
       THREE ports — tor → ACC_TOR_FRONT_PORT (nginx block) → ACC_TOR_PORT
       (gateway), beside ACC_PORT (gateway ← :443). Collapsing two roles onto one
       port is a bind collision, not a saving, and NOTHING on this box reports one:
       `nginx -t` parses and never binds, `systemctl reload` returns 0 before the
       master binds, and a status line that greps `ss` for a port two roles share
       goes green whichever won. Verify the listener after the reload. ⚠ Its
       /opt/grin/accio-<net>/gateway-state/ is DURABLE STATE, not a cache: losing it
       changes the receiving address of every wallet that ever connected.
       De-branding lives in web/052_accio/patches/ (S5, 16 files; S9 pass 1 added a
       17th; S10's theme added a 18th + 19th) — NEVER edit vendor/, and never rename
       MWC_WALLET_TYPE (it is a chain discriminator, not branding; S9+ deletes those
       paths). ⚠ The theme ("Orbital Dawn", S10) is ONE added stylesheet loaded LAST
       — styles/accio.css — plus three hooks; upstream's 21 stylesheets are NOT
       overlaid, so `git log PINNED_SHA..upstream/master` stays readable. It must
       stay last, retuning is a :root token edit, and it carries no url() because
       the standalone inliner only rewrites the double-quoted form. It is a
       light→dark FLIP (upstream's content panels are near-white with near-black
       text), so a missed rule is black text on a navy panel — check coverage
       mechanically, never by eye. ⚠ But a coverage sweep only sees selectors upstream
       SETS a colour on, and the flip's worst bug is the opposite: a quiet button
       (menu rail, language picker) that overrides only `background` and inherits our
       DARK base ink — the main nav shipped at 1.2:1. Resolve colour/background/
       box-shadow PER PROPERTY, PER BUTTON. Two more from the same review: a ground
       gradient needs its arithmetic done (colour reaches only `last-stop × ry` back
       from the centre — ours landed at y=110%, so the whole "dawn" rendered as
       nothing and looked deliberate), and a hairline on a sized box is an `inset`
       box-shadow, never a `border` (upstream is `content-box`, so a border pushed the
       seed-phrase dialog 2px past its parent).
       There is deliberately NO operator theme switch. ⚠ An S9 pass is a
       REDUCTION, not an `rm`, whenever the subsystem is referenced from a file we
       don't patch: pass 1 kept Mqs's 5-symbol external surface because
       `Slate.compactProofAddress` switches on `Mqs.ADDRESS_LENGTH` on the slatepack
       ENCODE path, un-gated — deleting the file would ReferenceError on every send
       with a payment proof. A removal must never change how a slate is READ.
       Every patch is marked `ACCIO PATCH`;
       grep for that rather than diffing — ⚠ which makes an UNMARKED patch invisible
       to the only review method there is. R8 found one (check_for_updates.js, six
       rewritten URLs, no marker, unread through S5/S6/S8 and four review packets;
       it was beaconing to api.github.com from the "offline" standalone). The rule
       and a table of all 19 files — including the five whose format cannot hold an
       inline marker — now live in patches/README.md, which is where a patch author
       actually looks. ⚠ Branding is a phrase map duplicated in backend/language.php
       and scripts/language.js: the maps being IDENTICAL is necessary and proves
       nothing, because a phrase map keyed on English word order misses every
       translator who reordered it — Dutch/Greek/Chinese shipped 27 unbranded
       strings, the page title and the CURRENCY LABEL among them. Check a new
       language against the map programmatically before shipping it.
       ⚠ Since S6 the build is GATED on
       052_lib_vendor.sh verifying vendor/ against vendor/SHA256SUMS (no bypass) —
       an edited or added byte there stops the build; the fix is a re-vendor in this
       repo, NEVER regenerating the manifest on the VPS.
       Design → docs/generated/script052_design.md;
       the build handoff is script052_implementation.md's session log, never the chat.
  053_ WooCommerce payment gateway
  054–058 FREE — assign a number when a build STARTS, not to an idea. Pick one that
       keeps the 05 hub menu ascending (menu groups run wallets → payments →
       giveaways, so a wallet product needs a low number); a 2nd giveaway takes 058
       and that band grows downward. Pre-assigning numbers to unbuilt ideas is what
       made that menu read 1,5,C,3,4,6,2. An unbuilt product has NO number, so its
       design doc lives under its HUB's number, never a reserved one. Planned:
       Payment Pro, GoblinPay (script09_design.md PART C). Note the script number is
       still unassigned even though the 05 hub now gives these a menu KEY — the two
       are independent (see the fixed-slot rule below).
  059_ Grin Drop (giveaway + donation portal) — moved from 052 on 2026-08-04 so the
       single-member Giveaways category parks at the end of the band and leaves a
       contiguous run for the two categories that grow (wallets, payments). At 054
       it would have cost a second migration (WooCommerce → 055). Full reasoning is
       in the 05_grin_wallet_service.sh header + docs/generated/script05_implementation.md.
  06_  Global health + price collector (06b = GrinScan explorer)
  07_  Mining services hub → 07_grin_mining_solo.sh (solo private, has a `lan` arg) and
       07_grin_mining_public_pool.sh (GRINIUM public pool; libs 07_lib_hub.sh /
       07_lib_satellite.sh; app code in web/07_mining_pool_public/)
  08_  Node admin centre (monitoring, nginx, firewall, backup, disk cleanup)
  08del_ Full cleanup (destructive)
  09_  Grin Connectivity Hub → 091_ Floonet relay deployer (deploys 2ro's floonet-rs via
       nginx/certbot — we deploy, don't fork), 092_ RESERVED for the mwixnet CoinSwap mixer
       (NOT BUILT — run one hop of a Grin CoinSwap route; ledger-level unlinkability, the one
       thing Tor cannot give. Design → script09_design.md PART D), and 093_ Grin Transporter
       (store-and-forward slate queue, was "Script 056"; Node+SQLite+Tor; Phase 1 built
       2026-07-11 STANDALONE — wiring into 059/07 stays deferred on wallet relay-receive
       support, design B.9 #6). 094+ free. Numbers swapped 2026-07-10 (Floonet first — serves
       existing users); Transporter moved 092→093 on 2026-08-04 to free 092 for the mixer.
       ⚠ That renumber is the band's ONE sanctioned exception to "assign a number when a build
       STARTS": 092 is held for an unbuilt product. It was affordable only because 093 has never
       been VPS-deployed AND its runtime identifiers are name-keyed, not number-keyed
       (grin-transporter-*, /opt/grin/transporter-*, grin_transporter.conf, ports 7456/7466) —
       so there was no Drop-style matched-key migration. Do not renumber a deployed product.
       Design → docs/generated/script09_design.md, memory project_comms_hub_09. Menu grouping is
       display-only; the number stays the label.
  lib/ Sourced libraries — always prefixed with parent script number
       e.g. 059_lib_wallet.sh, 059_lib_nginx.sh
```

## Common Commands
```bash
# Syntax check a single script
bash -n scripts/059_grin_drop.sh

# Syntax check all scripts at once
for f in scripts/**/*.sh scripts/*.sh; do bash -n "$f" && echo "OK: $f"; done

# Syntax check lib files
for f in scripts/lib/*.sh; do bash -n "$f" && echo "OK: $f"; done

# Search for a function across scripts
grep -n "function_name" scripts/*.sh scripts/lib/*.sh

# Check GRIN/BTC price
curl -s "https://api.nonlogs.io/api/markets/GRIN-BTC" | python3 -m json.tool
```

## Conventions
- Scripts use `set -euo pipefail` at the top
- **Menu loops under `set -e`:** every `case` dispatch MUST be `||`-guarded
  (`fn || true`) — an unguarded non-zero return kills the whole script instead of
  returning to the menu. Same trap: never end a function with `[[ ... ]] && cmd`
  (a false test makes the function return 1); use the `if`-form instead.
- **⚠ The corollary: a function called as `fn || …` or `if fn; then` runs with
  errexit DISABLED for its whole body**, and re-issuing `set -e` inside it does not
  undo that (POSIX ignores it there). Since that `||`-guard is mandatory above, it
  is the NORMAL case for every sourced lib — `set -euo pipefail` in the entry script
  protects almost nothing inside one. So in `lib/`, guard every command that creates,
  copies, moves or deletes with its own `|| { error "..."; return 1; }`, and never
  write a header comment claiming the caller's `set -e` covers you. A bare `cp`/`mv`
  in a lib is a silent failure that ships: 052's build wrote a *valid* SRI for an
  un-overlaid patch, and `mv "$new" "$outdir"` does not fail when `$outdir` still
  exists — it nests inside it while `success` prints. Full rationale → memory
  `project_lib_errexit_suppression`.
- Colors/logging defined once in the main script and inherited via source
- Config written to `/opt/grin/<service>/` on the target server
- Wallet secrets stored in `/opt/grin/<net>/.api_secret` (never hardcode)
- Testnet and mainnet always run independently on separate ports/dirs
- Lib files (scripts/lib/) are sourced, not executed — no shebang needed
- Function names: `snake_case`, prefixed with script prefix (e.g. `drop_`, `node_`)
- Option numbers in menus: numeric for main actions, letters (B/R/D/L) for secondary
- **Menu rows show NAMES, not script numbers.** A script's number (051, 05C …) is file/doc
  identity and is printed only on that product's own screen banner (`05C) GRIN WALLET QUICK
  SETUP`) — never duplicated onto the parent hub's row, where `A) 05C ·` reads as a broken
  sequence. So never name a product to an operator by number alone: say "the CMD Wallet
  quick setup (hub 05)", not "05C". Full rationale → `05_grin_wallet_service.sh` header.
- **Menu keys: FIXED SLOTS in hub 05, NUMBER-MATCHED in hub 08, positional elsewhere.**
  Hub 05 assigns every category a contiguous block of keys ending in a spare (wallets
  1-4, payments 5-8, giveaways 9); a row owns its key permanently, and planned/spare rows
  own theirs from the start. Hub 08 instead keys each row that HAS a sub-script to that
  script's last digit — 081→`1`, 082→`2`, 084→`4`, 085→`5`, 089→`9` — and fills the gaps
  (`3`,`6`,`7`,`8`) with its un-numbered inline features. Other hubs (07, 09) still assign
  the key positionally at render. **Outside hub 08 the key is NOT the script number** — in
  05, key 5 is WooCommerce (053) and key 9 is Drop (059); they coincide only by accident.
  - Hub 08's rule (adopted 2026-08-05, when Provider Access Watch sat on key 7 and Backup
    089 on key 10) works only because 08's rows *are* mostly numbered scripts — and it still
    cost one merge: Service & Port Dashboard + Chain Sync Status became `3) Node Status &
    Sync`, because 10 rows don't fit 9 digits. It does NOT generalise — in hub 05, 051 and
    05C would both want the same key. One rule per hub; never mix two in one menu.
  - Fixed slots exist because positional keys silently re-point every key below an
    insertion — that is how `2` came to mean Drop and then WooCommerce. The cost is that
    a category's spare is finite: when wallets outgrow slot 4 the next wallet cannot take
    5, so the blocks below shift in one deliberate migration.
  - A planned/spare key is LIVE and dispatches to `_slot_notice()` — one banner screen
    saying what the slot is for, "Nothing was installed or changed", Enter to return. It
    has no sub-menu and no prompts, so it can't be mistaken for the "coming soon"
    placeholder script that was deleted. A dead key would read as a broken menu, since
    fixed slots print the number and put it in the `Select [A / 1-9 / 0]` hint.
- **Retired menu key vs reassigned menu key.** A key nothing else took may live on as a
  silent alias (05 hub's `C` → CMD wallet). A key that changed hands never may — a second
  `case` arm for it is dead code (bash takes the first match) and, if reached, would open
  the wrong product with no error. The per-product banner is the mis-key safety net.
  Fixed slots are meant to end key churn, so this should now be history, not a live risk.
- Interactive SESSION logs use `_$(date +%Y%m%d_%H%M%S).log`; continuous fixed-name
  logs (watchdogs, daemons) are rotated via logrotate, not per-run dated.

## Server Deployment Paths (target VPS, not local)
```
/opt/grin/                  Root for all Grin services
  node/mainnet-prune/       Pruned mainnet node
  node/testnet-prune/       Pruned testnet node
  drop-test/ drop-main/     Grin Drop services
/etc/nginx/sites-available/ Nginx vhost configs
/etc/systemd/system/        Systemd unit files
```

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

Script 07 (mining pool) adds operator-configurable ports: **public stratum** `3333`,
**node built-in stratum upstream** `127.0.0.1:3416` (testnet `13416`), **Central API**
`8080` (testnet `8090`; localhost-bound; satellites reach it via the nginx HTTPS vhost,
IP-allowlist + shared-secret). Solo mining uses the same node stratum `3416`/`13416`.
⚠ The upstream port is **grin's own `stratum_server_addr` default and the toolkit does not
move it** — Script 01 leaves the addr alone, so the pool dials 3416 rather than the `3334`
an older plan called for. Three sites agree and must stay agreed: `pool_ensure_defaults`
in `07_grin_mining_public_pool.sh`, `node_stratum_port` in the pool backend's `lib/config.js`,
and `grin_sync_pool_stratum` in `lib/grin_node_secrets.sh` (which re-patches the toml).

### Node API method split — which endpoint a new call targets
- **Owner API** (`/v2/owner`, `.api_secret`): `get_status` (tip height + connections),
  `get_connected_peers`, `validate_chain`, `compact_chain` — management/status, trusted
  internal callers only. **Prefer `get_status` over `get_tip`** (`get_tip` returns "Method
  not found" in practice).
- **Foreign API** (`/v2/foreign`, `.foreign_api_secret`): `get_tip`, `get_block`, `get_header`,
  `get_outputs`, `get_unspent_outputs`, `get_pool_size`, `push_transaction` — public chain
  data, used by wallets connecting to a public node.
- **There is NO v1 REST API.** `GET /v1/status` (and the rest of `/v1/`) was removed in
  grin 5.x and returns **404 on a healthy node** — verified live 2026-08-09 against a synced
  5.5 mainnet node (`/v1/status` → 404 while `/v2/owner get_status` → height 3,967,196,
  46 peers). It fails as "node down", not as "bad endpoint", so it reads like an outage:
  Fidelius showed *Local Node — not running* for exactly this reason. Never write a `/v1/` call.
- **Probing a REMOTE node is a different question from probing the local one.** Script 04
  publishes only `/v2/foreign` and 403s `/v2/owner`, so a public node can answer `get_tip`
  (height) and nothing else — peer count and sync state are unknowable from outside and must
  be reported as *unavailable*, never as `0`/`unknown` (that renders a healthy node as idle).
- **Reachability needs a parsed result, not an HTTP 200.** Any web server, CDN error page or
  parked domain answers 200; only an unwrapped `{"Ok":…}` proves a Grin node is there. A bare
  `GET` on `/v2/foreign` proves nothing — it's a POST-only JSON-RPC endpoint.

### Pruned vs archive node — the `get_block` horizon (don't conflate headers with blocks)
A **pruned** node (`mainnet-prune`, `archive_mode=false`) keeps the full **header** chain +
full **kernel** set, so `get_header(N)` works for *all* heights and supply/difficulty/fee/
tx-count (header+kernel-derived) is available for any height. But `get_block(N)` returns the
block **body** (outputs/rangeproofs), pruned below the horizon — so **`get_block` FAILS for
old/genesis heights on a pruned node**; only blocks within the pruning horizon (~last weeks)
are retrievable. An **archive** node (`mainnet-full`, `archive_mode=true`) serves `get_block`
for every height since genesis. Sizing: archive `chain_data` (~18 GB+, mostly rangeproofs)
doesn't fit a small box's page cache, so **bulk random `get_block` reads thrash** a 4 GB box
(swap fills, kswapd pegged) — single on-demand reads are fine; bulk genesis crawls are not.
(GrinScan/grin-explorer specifics → memory `project_grinscan_archive_lazy`.)

### Node secret files (`/opt/grin/node/<net>-prune/`, created by Script 01)
| File | API | Key in grin.toml |
|------|-----|------------------|
| `.api_secret` | Node Owner API | `api_secret_path` |
| `.foreign_api_secret` | Node Foreign API | `foreign_api_secret_path` |

Auth format (both endpoints): `grin:<secret>` as HTTP Basic Auth user:password. The secret
is never sent over the internet — only server-to-server on localhost.

**Result unwrapping:** the node serialises Rust `Result<T,E>` as `{"Ok": T}` / `{"Err": E}`
inside the JSON-RPC `result` field. Consumers (e.g. GrinScan's `ownerApi()`/`foreignApi()`)
must call an `unwrapResult()` helper — never read `data.result` directly for node API calls.

```bash
# Test Owner API (testnet) — verify node is reachable
cd /opt/grin/node/testnet-prune
SECRET=$(cat .api_secret)
curl -s -u "grin:$SECRET" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"get_status","params":[],"id":1}' \
  http://127.0.0.1:13413/v2/owner
# Mainnet: replace 13413 with 3413 and testnet-prune with mainnet-prune
```

### Secret self-heal — `scripts/lib/grin_node_secrets.sh` (shared, sourced)
A node rebuild moves the node dir (mainnet-prune ↔ mainnet-full), silently breaking every
consumer that froze a secret path at setup time (classic symptom: collector `get_tip` →
HTTP 401). This lib is the single source of truth that re-resolves from the *live* node and
re-applies to all consumers, so no per-product re-run is needed.
- **Secret VALUES no longer rotate on rebuild** (since 2026-07-25) — see the key vault below.
  Only the secret *path* moves, which the appliers fix.
- **Resolvers:** `grin_live_node_dir <mainnet|testnet>` (running-node-aware: tmux session →
  instances-conf → standard path; mainnet prefers full archive) and
  `grin_node_secret_path <net> <foreign|owner>`. Use these, don't re-derive node dirs/paths.
- **Appliers:** idempotent per-consumer `grin_sync_*` (collector, GrinScan, wallets, Script-04
  nginx); `grin_secrets_sync_all` runs them all (no-op when a product is absent/correct).
- **Auto self-heal:** `grin_install_secret_sync` installs the lib to `/opt/grin/lib/`, a
  `/usr/local/bin/grin-secret-sync` CLI, and a `grin-secret-sync.timer` (every 5 min). Called
  from every product's setup that consumes node secrets. Manual one-shot: run `grin-secret-sync`.
- **New consumer:** source the lib, add a `grin_sync_<x>` + call it in `grin_secrets_sync_all`,
  and call `grin_install_secret_sync` in that product's setup. Don't re-implement resolution.

### Node API secret vault — `/opt/grin/keys/<net>/` (same lib)
Script 01 no longer mints fresh api/foreign secrets on every build. `generate_secrets <net>`
(Step 8b) delegates to `grin_secret_vault_ensure <net> <node_dir>`: **vault hit → restore;
miss → adopt the dir's existing secret, else generate and seed the vault.** One function
serves first install and every rebuild — there is no separate "first time" path.
- **Keyed by NETWORK, not directory** — a prune↔full rebuild moves the node dir, so keying by
  dir would rotate the secret anyway and defeat the point.
- **Direction matters.** Restore (vault → node dir) happens ONLY at build time, node down.
  The 5-min timer only *captures* (`grin_sync_vault_capture`, node dir → vault): the node reads
  its secret at startup and holds it in memory, so rewriting the file under a running node
  would make file and node disagree and 401 every consumer.
- **Corruption guards.** Every read goes through `_gns_read_secret` → `_gns_secret_sane`
  (non-blank, 8–128 chars, printable) so garbage is never restored/adopted/captured; it falls
  through to the next branch and gets replaced. Capture **seeds an empty vault slot freely but
  never overwrites an existing entry without proof** from `_gns_probe_secret` (rc 0 verified /
  1 rejected / 2 unknown); unknown keeps the vault.
- **A probe MUST include its control call.** A node with no `api_secret_path` accepts ANY
  credential — verified against a live node, where `grin:bogus` returned a full `get_status`.
  So `_gns_probe_secret` also calls with a deliberately wrong secret and reports UNKNOWN unless
  that one is rejected. Never treat a bare HTTP 200 from the node API as proof of a credential.
- **Never blanket-chown/chmod an existing secret file** — Script 04 sets the foreign secret to
  `root:<web_user>` 640 for its REST collector and the de-rooted pool sets `root:grinsecret` 640.
  `_gns_node_put` rewrites in place; only brand-new files get 600 grin:grin.
- **Rotation is explicit:** `grin-secret-sync --rotate <net>` (updates vault + node dir, re-syncs
  consumers, then **requires a node restart**). Vault rides along in 089 backups.

### grin-wallet secret files (`$WALLET_DIR/`, created by `grin-wallet init/recover`)
`grin-wallet init -hr` recovers from seed + writes config/secrets in the same dir;
`grin-wallet recover` displays the seed.

| File | API | Key in grin-wallet.toml |
|------|-----|--------------------------|
| `.foreign_api_secret` | Wallet Foreign API (3415/13415) | `api_secret_path` |
| `.owner_api_secret` | Wallet Owner API (3420/13420) | `owner_api_secret_path` |

The toolkit no longer patches `api_secret_path` (grin-wallet's default is used);
`wallet_data/.api_secret` is a dead legacy override.

## Grin API References
- **Wallet API tutorial:** https://github.com/grincc/grin-wallet-api-tutorial — Owner v3 (ECDH) + Foreign v2 JSON-RPC examples
- **Wallet API Rust docs:** https://docs.rs/grin_wallet_api/latest/grin_wallet_api/ — authoritative method signatures
- **grin-wallet repo:** https://github.com/mimblewimble/grin-wallet
- **grin node repo:** https://github.com/mimblewimble/grin
- **Official docs:** https://docs.grin.mw — slatepack spec, tx lifecycle
- **Grin forum:** https://forum.grin.mw

### Community reference — Goblin ecosystem (author "dog", github.com/2ro)
Independent Grin projects useful as reference when stuck (Nostr slatepack transport, mixnet
privacy, merchant payments). Full overlap analysis → memory `reference_goblin_ecosystem`.
- **goblin** (Rust) — P2P wallet, pay-by-username, slatepacks over Nostr DMs via Nym mixnet; Grim-based
- **floonet-rs / floonet-strfry / floonet-mixexit** — self-hostable Grin-native relay stack (docs.floonet.dev)
- **GoblinPay** (Rust) — receive-only merchant payment server (QR codes)
- **eranos** (TS) — private Grin fundraising; **magick.market** (TS) — Nostr Grin marketplace
- **grin-btcpay-woocommerce** (PHP) — WooCommerce↔BTCPay gateway (compare with our Script 053)
- Forum thread: https://forum.grin.mw/t/goblin-p2p-grin-with-nostr-and-mixnet-updated/12633 — docs: https://docs.goblin.st

Owner API v3 session flow: `init_secure_api` → ECDH key exchange → `open_wallet` → AES-256-GCM encrypted calls.
Foreign API v2: Basic Auth + secret file, no ECDH.

### Wallet ↔ Node — two opposite directions (don't conflate)
Two separate node↔wallet links, on different ports, doing different jobs:
- **① Node → Wallet Foreign API (3415/13415)** — `wallet_listener_url` in the node's
  `grin-server.toml` stratum config. The node's stratum calls **`build_coinbase`** to fund
  block rewards. This is a **local keychain operation** (the node passes fees+height in the
  request; the wallet never queries the node back). Also local-only: `receive_tx`,
  `check_version`. `finalize_tx` posts to the node only if `post_automatically=true`.
- **② Wallet → Node Foreign API (3413/13413)** — `node_api_secret_path` in `grin-wallet.toml`
  (→ node's `.foreign_api_secret`). The wallet, as a *client*, calls the node for `get_version`
  (startup), output scanning (balance), maturity (1440 blocks), and `push_transaction`
  (broadcast/spend/payout). Wrong/missing secret → node 403 → "Cannot parse response".

**The `get_version: Cannot parse response` error at `grin-wallet init` is HARMLESS** (recurs
in drop 059, pool 07, solo 07): init runs *before* the toml is patched, so the version probe
fails but init still writes the seed; the `node_api_secret_path` patch right after init fixes
runtime. **Coinbase reception never depends on ②** (it's `build_coinbase`, local) — so
"coinbase arrived" does NOT prove ② works. Only `grin-wallet info` (balance refresh) and
`send`/sweep exercise ② — those working *is* the real proof the wallet→node link is healthy.

**Tor** is neither 3413 nor 3415 — it's the wallet **Owner API (3420)** sending payouts
*outbound* to a miner's `.onion`. Node↔wallet on the same box is always plain localhost HTTP.
Patch locations: solo `lib/07_solo_wallet.sh` step 4; pool `lib/07_lib_pool_wallet.sh`
(~`node_api_secret_path`); drop `lib/059_lib_wallet.sh` `_drop_write_toml`.

### Passphrase input — use STDIN, not `-p` (verified 2026-07-29)
Several comments in this repo claim "grin-wallet has no stdin or env-var passphrase input —
`-p` is the only option." **That is wrong.** grin-wallet 5.4.1 pins `rpassword = "4.0"`, whose
`read_password()` reads **stdin** (`read_password_from_stdin(false)` — it does not open
`/dev/tty`) and takes an explicit non-TTY branch: *"if we don't have a TTY, the input was
piped so we bypass terminal hiding code"* → `stdin.read_line()`. What IS true: there is no
env-var input (the clap `pass` arg declares no `env`), so stdin is the only argv-free channel.
The rpassword 7 bump did **not** break this: grin-wallet v5.5.0 pins `rpassword 7.5.4`, which
branches on `stdin.is_terminal()` and still reads a piped passphrase. The toolkit pin is
unchanged at v5.4.1, so stdin feeding is safe on both — see memory
`project_grinwallet_stdin_rpassword`.
- **Feed the passphrase on stdin**: `exec grin-wallet … listen < "$pass_file"` (mode-600 file),
  or `printf '%s\n' "$p" | grin-wallet … info` (printf is a bash *builtin* — no argv at all).
  `init` asks twice; send two lines (a spare line is harmless if it ever asks once).
- **Why it matters:** `-p` puts the passphrase in `ps aux` / `/proc/<pid>/cmdline` for the
  entire life of the process. For a 24/7 listener that is a permanent leak to every local user,
  not the "brief, one-time" exposure the old comments describe.
- **Done in** `05_grin_wallet_service.sh` (CMD wallet). **Still on `-p` for the long-running
  listener:** `lib/07_solo_wallet.sh` and `lib/059_lib_wallet.sh` — convert when next touched.
  `lib/07_lib_pool_wallet.sh` is NOT one of them: its listener starts `owner_api` with no
  passphrase in argv and is unlocked over ECDH, so `-p` survives there only in `init` and a
  one-shot `address` probe (bounded exposure, not a 24/7 leak).
- **Exception — `init -hr` (recover):** leave stdin attached to the terminal so grin-wallet
  prompts for the mnemonic itself; never route a recovery phrase through a toolkit script.

## tmux Sessions — Always Use Bash
When generating `tmux new-session` commands (cron wrappers, watchdogs, any cron-run code),
always prefix with `SHELL=/bin/bash`:
```bash
SHELL=/bin/bash tmux new-session -d -s "name" -c "$DIR" "command"
```
**Why:** cron sets `SHELL=/bin/sh`; a shebang sets only the interpreter, not the env var
inherited by tmux child sessions. `export SHELL=` is insufficient if the tmux server was
already started — the inline prefix is the only reliable fix.

## Grin Node Launch Contract — Run as `grin`, with `HOME=$GRIN_DIR`, on the gtmux socket
**Every** code path that starts `grin server run` MUST go through
**`gnc_launch_node_session <dir> <binary> <sess>`** in `scripts/lib/grin_node_control.sh`
(or its conf-resolved wrapper `gnc_start_node_tmux <net>`). Never hand-roll a tmux launch.
The launcher enforces:
1. **Run as the `grin` user** — never root. A root-run node writes `root:root` files into the
   node dir; the next `grin`-owned start then gets `EACCES` and won't start.
2. **Set `HOME="$GRIN_DIR"`** (the node dir). grin 5.4.0 creates `$HOME/.grin/<chain>/` even
   when it loads the cwd `grin-server.toml`. The `grin` user's default home `/opt/grin` is
   `root:root`/unwritable → grin panics `Error loading config file: Permission denied`.
3. **`chown -R grin:grin "$GRIN_DIR"` immediately before launch** — reclaims root-owned
   leftovers (idempotent, prevents the EACCES in #1).
4. **One tmux server: grin's socket ("gtmux").** tmux is invoked *inside* `su grin`, so the
   tmux SERVER runs on grin's per-user socket (`/tmp/tmux-<uid>/default`) — view via the
   `gtmux` CLI, invisible to a plain root `tmux ls`. Before starting, the launcher kills the
   session name on BOTH tmux servers and sweeps leftover `grin server run` processes for the
   dir (`gnc_kill_grin_procs`). A root-socket session next to a gtmux one is the classic
   "lock file is held by another grin process" duplicate.

Stop paths must use `gnc_kill_grin_session` / `gnc_kill_all_grin_sessions` (both sockets) and
end with a `gnc_kill_grin_procs` sweep. Session checks use `gnc_has_grin_session` (sets
`GNC_SESSION_SOCKET` = grin|root for the right attach hint). Reboot autostart defaults
(`gnk_autostart_enable`, Script 01 Super Auto + Script 03 G): **mainnet 5 s, testnet 1000 s**
(grin v5.5 boot is heavy — a slow VPS cannot start two nodes together).

**Do NOT** debug "node won't start" by running as root in the node dir — it works for root
but leaves `root:root` files that re-break the `grin` user. Reproduce as the service user.

## Grin Hashrate Formula (Cuckatoo32)
**Do NOT use `difficulty / 60` — it gives values ~366× too high.** Correct formula (matches
`06_collector.py` and `aglkm/grin-explorer`):
```
GPS = diff_delta × 42 / block_time_seconds / 16384
```
- `diff_delta` — `total_difficulty[n] - total_difficulty[n-1]` (cumulative, graph-weight-scaled)
- `42` — Cuckatoo32 cycle length (proof size)
- `block_time_seconds` — actual elapsed seconds between the two blocks (real timestamps, not fixed 60)
- `16384` — C32 solution rate = `32 × 2^(32−23)` = `32 × 512`

Display units: **G/s** (<1 000), **kG/s** (≥1 000), **MG/s** (≥1 000 000) — matches world.grin.money.
History endpoints with no per-block timestamp use the 60s target: `diff × 42 / 60 / 16384`.

## Nginx Configuration — Shared Helpers & Conflict Prevention
Nginx loads ALL `/etc/nginx/conf.d/*.conf` into the http context — two scripts defining the
same `limit_req_zone` differently → nginx error. All rate-limit zone creation goes through one
primitive in `scripts/lib/nginx_shared_helpers.sh`:
```bash
nginx_ensure_rate_limit_zone <zone_name> <rate> [size=10m] [conf_basename] [force]
```
It grep-guards existing definitions and writes `/etc/nginx/conf.d/<conf_basename>.conf` if
missing (no-op if the file exists — delete the file to regenerate). A non-empty 5th arg
(`force`) re-asserts the rate from the toolkit source on every run instead, so editing the
value in the lib actually reaches an installed box; `nginx_ensure_grin_api_zone` passes it.

- **SHARED zones** (multiple scripts) → add a named wrapper in the lib so every caller passes
  identical args → byte-identical output → last-write-wins is safe. Current: `grin_api`
  (`nginx_ensure_grin_api_zone`, `300r/m`, used by Scripts 04 + 06).
- **SCRIPT-SPECIFIC zones** → call the primitive (or `nginx_ensure_rate_limit_zones
  <conf_basename> <zone:rate[:size]> ...`) with the script's own params. Name conf files with a
  `script##-` prefix (`script04-…`, `script07-…`). The owning script's detail stays in memory.
- `grin_conn` (limit_conn, Script 04) → `/etc/nginx/conf.d/grin-conn-limit.conf` via
  `nginx_ensure_conn_limit_zone`. **Never patch a zone inline into `nginx.conf`** — a Debian
  nginx package upgrade resets `nginx.conf` to default, wiping an inline zone while the site
  config that references it survives → boot fails "zero size shared memory zone".

### Rules
1. **Never write `limit_req_zone …` inline** — always the primitive or a named wrapper.
2. **Same path + same content = safe** (byte-identical writes; named wrappers enforce this).
3. **Zone names must be globally unique.** Before adding: `grep -r "zone=name_here" scripts/ lib/`.
4. **`nginx -t` before any `systemctl reload nginx`.**
5. **Let's Encrypt bootstrap:** never write a vhost referencing `/etc/letsencrypt/live/<domain>/…`
   before the cert exists (`nginx -t` hard-fails). Pattern: HTTP-only vhost → reload →
   `certbot --nginx` → then write the full SSL vhost. Include `options-ssl-nginx.conf` only when
   the file exists; never put shell syntax (`2>/dev/null`) inside an nginx config.

## Generated & Temporary Files
ALL generated docs go to `docs/generated/` — never scatter into `web/` etc. The old
`flowcharts/` dir was merged into `docs/generated/` (2026-07-09); don't recreate it.

**Naming:** `script<XX>_<type>_<optional_service>_<optional_date>.md`
- `script<XX>` — REQUIRED prefix; `type` — `design`/`implementation`/`security_audit`/`analysis`/`reference`/`report`; `date` — `YYYY-MM-DD` only when multiple versions exist.
- **Max 3 files per script:** `script##_design.md` / `script##_implementation.md` / `script##_security_audit.md`.

✅ `script07_security_pool_audit_2026-05-15.md`  ❌ `SECURITY_FIXES.md` (missing prefix)

Before creating any `.md`, check if it should merge into an existing `script##_[type].md`.

## Local Test Processes — Kill Everything You Start
The dev machine is the user's **single Windows workstation**, not a disposable CI box. Every
process started locally to test/verify (python `http.server`, `node <server>.js`, jsdom
harnesses, headless browsers, watchers) MUST be killed **in the same session that started it**.
- **Prefer a process that exits on its own** — one-shot `curl`/`Invoke-WebRequest`, `bash -n`,
  `node -e`, a jsdom script. Only start a server when nothing one-shot can do the job.
- **If a server is unavoidable:** bind localhost explicitly (`python -m http.server PORT
  --bind 127.0.0.1`), capture the PID, `Stop-Process -Force` it as soon as the check is done.
- **Kill the whole tree.** Windows `python.exe` from `WindowsApps` is a launcher stub that
  spawns a second real `pythoncore-*\python.exe`, and Bash-tool launches sit under 2–3
  `bash.exe` wrappers — killing one PID leaves the listener alive.
- **Background tasks count too** — a `run_in_background` command or a spawned agent left
  running is the same problem.
- **End-of-session sweep**, alongside the `git status --short` temp-file check:
  ```powershell
  Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'Temp[\\/]claude[\\/]|claude[\\/]shell-snapshots|http\.server' }
  ```
  Never match or kill `msedge`/`chrome`/`Code` — those are the user's own apps.

**Why it compounds:** an orphan squats its port, so the next run picks a *new* port instead of
failing loudly. On 2026-07-26 a sweep found **35 orphans from 7/23–7/25 holding 11 ports**
(8479, 8791–8799, 8801), two bound to `::` (all interfaces — LAN-reachable, not just
localhost). Nothing had autostart persistence; they simply survived **10 days of uptime**
because the box hadn't rebooted. A reboot clears them — that is luck, not a cleanup strategy.

## Per-Product Detail — pointers (not in this file)
Deep implementation facts live in local memory + committed docs. When working on a product,
recall the relevant memory and read its doc:
- **Script 07 public mining pool** (architecture, locked design decisions, admin panel, CMS,
  multi-region hub/satellite, payments) → memory `project_pool_*` + `docs/generated/script07_*.md`.
  The pool lives in THIS repo (`scripts/07_grin_mining_public_pool.sh` + `web/07_mining_pool_public/`);
  the standalone GRINIUM repo is **deprecated — never edit it**.
- **GrinScan / grin-explorer (06b), pruned vs archive runtime behaviour** → memory `project_grinscan_archive_lazy`.
- **Solo mining** (block-finder attribution, SQLite collector) → memory `project_testnet_solo_mining`, `project_solo_sqlite_storage`, `project_solo_block_finder`.

## Debugging — Confirm Root Cause Before Editing
When a bug is reported, **confirm the root cause with evidence before changing code.** A
plausible-looking suspect is not a confirmed cause.
- Ask the operator to run diagnostics and read the *actual* output first; let evidence point
  to the cause. Don't jump from a guess (a suspicious commit) straight to an edit — state the
  hypothesis, then verify.
- Make sure each diagnostic actually proves what you think — a test that can't observe the
  thing you're checking is not evidence.
- "It worked before" often means a different environment/input, not a code regression — rule
  that out before blaming a change.
- Only once the cause is confirmed, make the **smallest** fix at the true source rather than
  adding compensating logic elsewhere.

## Do Not
- Never run toolkit scripts locally — they assume a Linux VPS with root access
- Never hardcode wallet API secrets or passwords in scripts
- Never skip `bash -n` syntax check before committing a shell script change
- Never use `--floonet` — the correct testnet flag is `--testnet`
- Never mix mainnet and testnet ports or directories
- Don't add `#!/bin/bash` to lib files — they are sourced, not executed
- Never leave a local test process running — kill every server/probe you start, in the same
  session (see *Local Test Processes*); never bind a test server to `0.0.0.0`/`::`
