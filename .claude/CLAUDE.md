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
- **Web backend:** Node.js/Express + SQLite (scripts 052–053, and the Script 07 public-pool backend)
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
  05_  Wallet services hub (launches 051–053; also hosts the 05C CMD-wallet quick setup)
  051_ Private web wallet (051x_ = XP-themed variant, launched from inside 051)
  052_ Grin Drop (giveaway + donation portal)
  053_ WooCommerce payment gateway
  054+ UNALLOCATED — assign a number when a build STARTS, not to an idea. Pick one
       that keeps the 05 hub menu ascending (menu groups run wallets → giveaways →
       payments, so a wallet product needs a low number). Planned products get a dim
       footer line with no menu key. Pre-assigning numbers to unbuilt ideas is what
       made that menu read 1,5,C,3,4,6,2. An unbuilt product has NO number, so its
       design doc lives under its HUB's number, never a reserved one. Planned:
       Payment Pro, Public WASM wallet (script05_design.md PART A), GoblinPay
       (script09_design.md PART C).
  06_  Global health + price collector (06b = GrinScan explorer)
  07_  Mining services hub → 07_grin_mining_solo.sh (solo private, has a `lan` arg) and
       07_grin_mining_public_pool.sh (GRINIUM public pool; libs 07_lib_hub.sh /
       07_lib_satellite.sh; app code in web/07_mining_pool_public/)
  08_  Node admin centre (monitoring, nginx, firewall, backup, disk cleanup)
  08del_ Full cleanup (destructive)
  09_  Grin Connectivity Hub → 091_ Floonet relay deployer (deploys 2ro's floonet-rs via
       nginx/certbot — we deploy, don't fork) and 092_ Grin Transporter (store-and-forward
       slate queue, was "Script 056"; Node+SQLite+Tor; Phase 1 built 2026-07-11 STANDALONE —
       wiring into 052/07 stays deferred on wallet relay-receive support, design B.9 #6).
       Numbers swapped 2026-07-10 (Floonet first — serves existing users). Design →
       docs/generated/script09_design.md, memory project_comms_hub_09. Menu grouping is
       display-only; the number stays the label.
  lib/ Sourced libraries — always prefixed with parent script number
       e.g. 052_lib_wallet.sh, 052_lib_nginx.sh
```

## Common Commands
```bash
# Syntax check a single script
bash -n scripts/052_grin_drop.sh

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
- Colors/logging defined once in the main script and inherited via source
- Config written to `/opt/grin/<service>/` on the target server
- Wallet secrets stored in `/opt/grin/<net>/.api_secret` (never hardcode)
- Testnet and mainnet always run independently on separate ports/dirs
- Lib files (scripts/lib/) are sourced, not executed — no shebang needed
- Function names: `snake_case`, prefixed with script prefix (e.g. `drop_`, `node_`)
- Option numbers in menus: numeric for main actions, letters (B/R/D/L) for secondary
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
**node built-in stratum upstream** `127.0.0.1:3334` (testnet `13334`; set the node's
`stratum_server_addr` here), **Central API** `8080` (localhost-bound; satellites reach it
via the nginx HTTPS vhost, IP-allowlist + shared-secret). Solo mining keeps legacy `3416`.

### Node API method split — which endpoint a new call targets
- **Owner API** (`/v2/owner`, `.api_secret`): `get_status` (tip height + connections),
  `get_connected_peers`, `validate_chain`, `compact_chain` — management/status, trusted
  internal callers only. **Prefer `get_status` over `get_tip`** (`get_tip` returns "Method
  not found" in practice).
- **Foreign API** (`/v2/foreign`, `.foreign_api_secret`): `get_block`, `get_header`,
  `get_outputs`, `get_unspent_outputs`, `get_pool_size`, `push_transaction` — public chain
  data, used by wallets connecting to a public node.

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
in drop 052, pool 07, solo 07): init runs *before* the toml is patched, so the version probe
fails but init still writes the seed; the `node_api_secret_path` patch right after init fixes
runtime. **Coinbase reception never depends on ②** (it's `build_coinbase`, local) — so
"coinbase arrived" does NOT prove ② works. Only `grin-wallet info` (balance refresh) and
`send`/sweep exercise ② — those working *is* the real proof the wallet→node link is healthy.

**Tor** is neither 3413 nor 3415 — it's the wallet **Owner API (3420)** sending payouts
*outbound* to a miner's `.onion`. Node↔wallet on the same box is always plain localhost HTTP.
Patch locations: solo `lib/07_solo_wallet.sh` step 4; pool `lib/07_lib_pool_wallet.sh`
(~`node_api_secret_path`); drop `lib/052_lib_wallet.sh` `_drop_write_toml`.

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
nginx_ensure_rate_limit_zone <zone_name> <rate> [size=10m] [conf_basename]
```
It grep-guards existing definitions and writes `/etc/nginx/conf.d/<conf_basename>.conf` if
missing (no-op if the file exists — delete the file to regenerate).

- **SHARED zones** (multiple scripts) → add a named wrapper in the lib so every caller passes
  identical args → byte-identical output → last-write-wins is safe. Current: `grin_api`
  (`nginx_ensure_grin_api_zone`, `30r/m`, used by Scripts 04 + 06).
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
