# Grin Node Toolkit — Claude Instructions

## Project Overview
A unified bash toolkit for deploying and managing Grin cryptocurrency nodes and
infrastructure on Linux servers (Debian/Ubuntu, Rocky Linux, AlmaLinux 10+).
Run as root/sudo on a remote VPS — not executed locally on this machine.

## Persisting Knowledge — Put Durable Facts HERE, Not Local Memory
The user works across **macOS and Windows**. The auto-memory dir
(`~/.claude/projects/.../memory/`) is **local to one machine and does NOT sync** — a fact
saved there on Windows is invisible on macOS. **Durable project/technical facts go in THIS
git-tracked `.claude/CLAUDE.md`** (and committed docs under `docs/generated/`) so both machines
see them. Reserve the local memory dir only for machine-specific or throwaway notes. When you
learn a reusable fact worth remembering, **edit CLAUDE.md**, don't write a local memory file.

## Tech Stack
- **Shell:** Bash (primary language — all scripts must pass `bash -n` syntax check)
- **Web backend:** Node.js/Express + SQLite (scripts 052–055, and the Script 07 public-pool backend)
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
  05_  Wallet services hub (launches 051–055)
  051_ Private web wallet
  052_ Grin Drop (giveaway + donation portal)
  053_ WooCommerce payment gateway
  054_ Payment Pro
  055_ Public WASM wallet
  06_  Global health + price collector
  07_  Mining services hub → 07_grin_mining_solo.sh (solo private mining) and
       07_grin_mining_public_pool.sh (GRINIUM public pool; libs 07_lib_hub.sh /
       07_lib_satellite.sh; app code in web/07_mining_pool_public/)
       Solo (07_grin_mining_solo.sh) has a `lan` launch arg (`bash 07_grin_mining_solo.sh lan`,
       sets global SOLO_NET_MODE=lan) — same product, but the stats page deploys over
       plain HTTP on a chosen LAN IP:port (no domain/certbot/Basic Auth) for internal
       networks. Only solo_deploy_stats_page branches on the mode; all mining mechanics
       are shared. The 07 hub menu exposes it as option 3 (hub_launch solo-lan); LAN and
       public solo are the SAME exclusivity bucket (same ports/dirs).
  08_  Node admin centre (monitoring, nginx, firewall, backup)
  08del_ Full cleanup (destructive)
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

## Server Deployment Paths (target VPS, not local)
```
/opt/grin/                  Root for all Grin services
  node/mainnet-prune/       Pruned mainnet node
  node/testnet-prune/       Pruned testnet node
  drop-test/                Grin Drop testnet service
  drop-main/                Grin Drop mainnet service
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

Script 07 (mining pool) adds operator-configurable ports not in the table above:
- **Public stratum** — miners connect here; default `3333` (same for both networks)
- **Node built-in stratum (upstream)** — localhost only; the pool's stratum proxy connects here as a client; default `3334`. Set the Grin node's `stratum_server_addr` to `127.0.0.1:3334`.
- **Central API / Pool HTTP API** — stats + satellite share/block ingestion (`/api/shares`, `/api/blocks`); default `8080` (same for both networks). Ingestion is IP-allowlisted + shared-secret authenticated.

> All three modes use the same ports: public stratum `3333`, node built-in stratum upstream `127.0.0.1:3334` (testnet `13334`), Central API `8080`. The single-box installer was migrated off the legacy `3416/3417/3002` in 2026-06. (Solo mining — `07_grin_mining_solo.sh` — is a separate product and keeps `3416`.)

Secret files — two per service, each with a Foreign and Owner secret:

**Grin node** (`/opt/grin/node/<net>-prune/`) — created by script 01
| File | API | Who reads it | Key in grin.toml |
|------|-----|-------------|------------------|
| `.api_secret` | Node Owner API | Script 04, Python collectors, GrinScan (06b) | `api_secret_path` |
| `.foreign_api_secret` | Node Foreign API | grin-wallet via `node_api_secret_path`, GrinScan (06b) | `foreign_api_secret_path` |

Node API method split — use this to decide which endpoint a new call should target:
- **Owner API** (`/v2/owner`, `.api_secret`): `get_status` (includes tip height + connections), `get_connected_peers`, `validate_chain`, `compact_chain` — node management/status, trusted internal callers only. Used by: GrinScan (06b) for polling, monitoring scripts.
- **Foreign API** (`/v2/foreign`, `.foreign_api_secret`): `get_block`, `get_header`, `get_outputs`, `get_unspent_outputs`, `get_pool_size`, `push_transaction` — public chain data. Used by: wallets connecting to a public node, external block data queries.
- **Note:** prefer `get_status` over `get_tip` for the node Owner API — `get_tip` returns "Method not found" in practice.

Auth format for node API calls (both endpoints): `grin:<secret>` as HTTP Basic Auth username:password.
The secret is NEVER sent over the internet — only used for server-to-server calls on localhost.

**Result unwrapping:** The Grin node serialises Rust `Result<T,E>` as `{"Ok": T}` or `{"Err": E}` inside the JSON-RPC `result` field.
GrinScan's `ownerApi()` and `foreignApi()` helpers call `unwrapResult()` to strip this wrapper.
Do NOT access `data.result` directly for node API calls — always go through these helpers.

```bash
# Test Owner API (testnet) — use this to verify node is reachable
cd /opt/grin/node/testnet-prune
SECRET=$(cat .api_secret)
curl -s -u "grin:$SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"get_status","params":[],"id":1}' \
  http://127.0.0.1:13413/v2/owner

# Test Foreign API (testnet)
SECRET=$(cat .foreign_api_secret)
curl -s -u "grin:$SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"get_tip","params":[],"id":1}' \
  http://127.0.0.1:13413/v2/foreign

# Same for mainnet — replace 13413 with 3413 and testnet-prune with mainnet-prune
```

GrinScan copies node secrets into `/opt/grin/grinscan/{test,main}/` during Configure (2).
If node secrets are regenerated (Script 01 rebuild), re-run GrinScan Configure (2) to refresh copies.

**grin-wallet** (`$WALLET_DIR/`) — both created by `grin-wallet init/recover`
`grin-wallet init -hr` to recover wallet from seed and store config/secret files in same dir.
`grin-wallet recover` to display seed

| File | API | Who reads it | Key in grin-wallet.toml |
|------|-----|-------------|--------------------------|
| `.foreign_api_secret` | Wallet Foreign API (3415/13415) | Node.js `foreignApiCall()`, external senders | `api_secret_path` |
| `.owner_api_secret` | Wallet Owner API (3420/13420) | Node.js `ownerApiSession()` (ECDH) | `owner_api_secret_path` |

Note: `wallet_data/.api_secret` was a previous toolkit override — no longer used.
The toolkit no longer patches `api_secret_path` in grin-wallet.toml; grin-wallet's own default is used.

## Grin API References

- **Wallet API tutorial**: https://github.com/grincc/grin-wallet-api-tutorial
  — JSON-RPC examples for Owner API v3 (ECDH flow) and Foreign API v2
- **Wallet API Rust docs**: https://docs.rs/grin_wallet_api/latest/grin_wallet_api/
  — Authoritative method signatures and parameter types
- **grin-wallet repo**: https://github.com/mimblewimble/grin-wallet — binary releases
- **grin node repo**: https://github.com/mimblewimble/grin — node config, API
- **Official docs**: https://docs.grin.mw — slatepack spec, transaction lifecycle
- **Grin forum**: https://forum.grin.mw — ecosystem announcements, known issues

Owner API v3 session flow: `init_secure_api` → ECDH key exchange → `open_wallet` → AES-256-GCM encrypted calls.
Foreign API v2: Basic Auth + secret file, no ECDH.

### Wallet ↔ Node — two opposite directions (don't conflate)

There are **two separate node↔wallet links**, on different ports, doing different jobs:

- **① Node → Wallet Foreign API (3415/13415)** — `wallet_listener_url` in the node's
  `grin-server.toml` stratum config. The node's stratum calls **`build_coinbase`** to fund
  block rewards. Confirmed from docs.rs `grin_wallet_api::Foreign`: build_coinbase "builds a
  new unconfirmed coinbase output in the wallet" — a **local keychain operation**; the node
  passes fees+height in the request (`BlockFees`), the wallet **never queries the node back**.
  Also local-only: `receive_tx`, `check_version`. `finalize_tx` posts to the node only if
  `post_automatically=true`.
- **② Wallet → Node Foreign API (3413/13413)** — `node_api_secret_path` in `grin-wallet.toml`
  (→ node's `.foreign_api_secret`). The wallet, as a *client*, calls the node for `get_version`
  (startup), output scanning (balance confirm), maturity (1440 blocks), and `push_transaction`
  (broadcast/spend/payout). Wrong/missing secret → node 403 → "Cannot parse response".

**The `get_version: Cannot parse response` error at `grin-wallet init` is HARMLESS** (recurs in
drop 052, pool 07, solo 07): init runs *before* the toml is patched, so the version probe fails
but init still writes the seed; the `node_api_secret_path` patch (run right after init) fixes
runtime. **Coinbase reception never depends on ② at all** (it's `build_coinbase`, local) — so
"coinbase arrived" does NOT prove ② works. Only `grin-wallet info` (balance refresh) and
`send`/sweep exercise ② — those working *is* the real proof the wallet→node link is healthy.

**Naming gotcha:** Foreign API's `check_version` (wallet serving its own version) ≠ the
`get_version` in the error. The error comes from `grin_wallet_impls::node_clients::http` =
grin-wallet acting as a CLIENT calling the NODE's foreign `get_version` (direction ②).

**Tor** is neither 3413 nor 3415 — it's the wallet **Owner API (3420)** sending payouts
*outbound* to a miner's `.onion`. Node↔wallet on the same box is always plain localhost HTTP.

Patch locations: solo `scripts/lib/07_solo_wallet.sh` step 4; pool
`scripts/lib/07_lib_pool_wallet.sh` (~`node_api_secret_path`); drop
`scripts/lib/052_lib_wallet.sh` `_drop_write_toml`.

## tmux Sessions — Always Use Bash
When generating `tmux new-session` commands (in cron wrappers, watchdog scripts, or any
code that may run from cron), always prefix the call with `SHELL=/bin/bash`:

```bash
SHELL=/bin/bash tmux new-session -d -s "name" -c "$DIR" "command"
```

**Why:** cron sets `SHELL=/bin/sh`; a shebang only sets the interpreter, not the env var inherited by tmux child sessions. `export SHELL=` is insufficient if the tmux server was already started by another process — the inline prefix is the only reliable fix.

## Grin Node Launch Contract — Run as `grin`, with `HOME=$GRIN_DIR`

**Every** code path that starts `grin server run` (Script 01 `start_grin`, `grin_node_control.sh`
`gnc_start_node_tmux`, the `grin_node_keepalive.sh` `@reboot` autostart line) MUST:

1. **Run as the `grin` user** — never as root. A root-run node writes `root:root` files
   (`grin-server.log`, `chain_data/…`) into the node dir; the next `grin`-owned start then
   gets `EACCES` (e.g. `logger.rs:218 Failed to create logfile`) and the node won't start.
2. **Set `HOME="$GRIN_DIR"`** (the node dir). grin 5.4.0 still creates its `$HOME/.grin/<chain>/`
   work area **even when it loads the cwd `grin-server.toml`** (confirmed via strace: it reads
   the cwd config *and* touches `$HOME/.grin/main`). The `grin` user's default home is `/opt/grin`,
   which is `root:root` and unwritable → grin panics `Error loading config file: Permission denied`
   while trying to `mkdir /opt/grin/.grin`. Pointing `HOME` at the node dir keeps grin's home area
   inside the standard `/opt/grin/node/<net>` path and never touches `/opt/grin/.grin` or `~/.grin`.
3. **`chown -R grin:grin "$GRIN_DIR"` immediately before launch** — reclaims any root-owned
   leftovers (idempotent, cheap, prevents the EACCES in #1).

Canonical form (matches all three launch points):
```bash
chown -R grin:grin "$GRIN_DIR" 2>/dev/null || true
su -s /bin/bash -c 'cd "$GRIN_DIR" && HOME="$GRIN_DIR" ./grin server run' grin
```

**Do NOT** debug a "node won't start" by running `./grin server run` as root in the node dir —
it *works* for root (root can write anywhere) but leaves `root:root` files that re-break the
`grin` user. Reproduce as the service user: `su -s /bin/bash -c 'cd $DIR && HOME=$DIR ./grin server run' grin`.

## Grin Hashrate Formula (Cuckatoo32)

**Do NOT use `difficulty / 60` — it gives values ~366× too high.**

The correct formula (matches `06_collector.py` and `aglkm/grin-explorer`):

```
GPS = diff_delta × 42 / block_time_seconds / 16384
```

- `diff_delta`         — `total_difficulty[n] - total_difficulty[n-1]` (cumulative, already graph-weight-scaled)
- `42`                 — Cuckatoo32 cycle length (proof size)
- `block_time_seconds` — actual elapsed seconds between the two blocks (use real timestamps, not fixed 60)
- `16384`              — C32 solution rate = `32 × 2^(32−23)` = `32 × 512`

Display units: **G/s** (< 1 000), **kG/s** (≥ 1 000), **MG/s** (≥ 1 000 000) — matches world.grin.money.

In GrinScan (`server.js`):
```js
// live (stmtTopTwoDiff gives actual timestamp per block)
hashrateGps = perBlockDiff * 42 / dt / 16384;          // dt = actual seconds

// history endpoint (actual block time unavailable — use 60s target)
hashrate_gps = row.difficulty * 42 / 60 / 16384;
```

## Solo Mining — Block-Finder Attribution (Script 07 solo collector)

The Grin node's **`Solution Found for block N` log line does NOT name the worker** — it
only carries height + abbreviated hash. To show *which miner found a block* (the "Blocks"
column in the stats page "Work share by period" table), the collector
(`scripts/lib/07_mining_block_collector.py`) **derives** the finder by correlation: the
winning submission is also logged as a `Got share at height N … submitted by W` line
**immediately before** the `Solution Found for block N` line, so the collector tracks the
last share seen (`last_share = {height, worker}`) and, when a `Solution Found` for the same
height arrives, attributes `found_by[height] = worker` (first finder wins). `SHARE_RE`
captures the share height for this; `found_blocks.found_by TEXT` persists it (additive
`_migrate_schema` ALTER for existing DBs).

Caveats (by design, documented in-code + in the UI footnote): blocks recovered from the
**rotated-log backfill have no share context** → left unattributed ("unknown", omitted from
the per-nick tally but still counted in `blocks_matured`). And this is a **leaderboard stat
ONLY** — payouts stay split by *work share* (Σ share-difficulty), never by who got the lucky
block; attributing reward to the finder would undo the fair PPLNS-style split. `compute_split`
attaches `blocks_found` per nickname per period (bucketed by the block's found-ts UTC day).

## Nginx Configuration — Shared Helpers & Conflict Prevention

**Critical:** Nginx config files from multiple scripts can conflict if they define
the same zones, upstreams, or directives in the same context (http/server/location).
Nginx loads ALL files in `/etc/nginx/conf.d/*.conf` into the http context — if two
scripts define the same `limit_req_zone` with different names or rates, nginx errors.

### Rate-limit zones — primitive + named wrappers
All rate-limit zone creation goes through one primitive in `scripts/lib/nginx_shared_helpers.sh`:

```bash
nginx_ensure_rate_limit_zone <zone_name> <rate> [size=10m] [conf_basename]
```

Behaviour: grep-guards against existing definitions, writes
`/etc/nginx/conf.d/<conf_basename>.conf` if missing. Ops can edit the conf file
manually to override the rate — the helper detects the existing zone and skips.

**For SHARED zones** (multiple scripts need the same zone), add a named wrapper
in the lib so every caller passes identical args → byte-identical output →
last-write-wins is safe regardless of which script runs first:

```bash
nginx_ensure_grin_api_zone() {
    nginx_ensure_rate_limit_zone "grin_api" "30r/m" "10m" "grin-rate-limit"
}
```

Every script that needs `grin_api` calls `nginx_ensure_grin_api_zone` — never
the primitive directly, never an inline `cat > /etc/nginx/conf.d/...` heredoc.

**For SCRIPT-SPECIFIC zones** (zone used by only one script), call the primitive —
or the multi-zone variant `nginx_ensure_rate_limit_zones <conf_basename> <zone:rate[:size]> ...`
— with the script's own parameters:

```bash
# In Script 07 (public pool) — actual call (all rates carry the 2026-06 ×20 bump):
nginx_ensure_rate_limit_zones "script07-${POOL_SERVICE}" \
    "${POOL_SERVICE}_auth:200r/m"   "${POOL_SERVICE}_api:600r/m" \
    "${POOL_SERVICE}_static:6000r/m" "${POOL_SERVICE}_captcha:600r/m" \
    "${POOL_SERVICE}_admin:2400r/m"  "${POOL_SERVICE}_ingest:2400r/m"
```

Note: the helper is a no-op if the conf file already exists — deleting
`/etc/nginx/conf.d/<basename>.conf` (or running pool cleanup) is the signal to regenerate,
e.g. after adding a new zone to the list.

Current named wrappers:

| Zone | Wrapper | Rate | Used by |
|---|---|---|---|
| `grin_api` (limit_req) | `nginx_ensure_grin_api_zone` | `30r/m` | Scripts 04, 06 |

### Script-specific zones — stay in the script that owns them
- `grin_conn` (Script 04 only) — defined inline in Script 04 inside `nginx.conf` http block
- `${POOL_SERVICE}_auth/_api/_static/_captcha/_admin/_ingest` (Script 07 only) — written via the multi-zone helper; `_ingest` covers satellite `/api/shares` + `/api/blocks` so relay batches aren't throttled by the public `_api` zone. **ALL zone rates carry a 2026-06 ×20 "loosen now, tighten later" bump** (operator request) so request throttling never breaks normal use during early testing — the real controls are JWT + login captcha + per-account lockout + IP auto-ban, NOT these throttles. Current rates: `_auth 200r/m`, `_api 600r/m`, `_static 6000r/m` (burst 100), `_captcha 600r/m`, `_admin 2400r/m`, `_ingest 2400r/m`. The `_static` bump matters most because every public page load re-fetches ~a dozen assets — incl. `public-shell.js`, which injects the header/nav — all keyed per-IP on `_static`, so the old 60r/m cap 503'd assets on a few fast navigations → pages rendered as plain HTML with no CSS and a missing nav. `pool_setup_nginx` self-heals an existing install (rm's the managed `script07-<svc>.conf` so the full zone list regenerates) when it carries any earlier-generation rate (auth `3|10r/m`, static `60|300r/m`) or is missing the `_captcha`/`_admin` zones. **To tighten later:** lower the rates in `pool_setup_nginx`'s `nginx_ensure_rate_limit_zones` call AND the app buckets in `lib/rate-limiter.js` (`this.limits` — `public 1200 / auth 200 / api 600 / admin 2400`, also ×20), then re-run 4) Setup nginx.
- Per-domain bandwidth maps (Script 02) — defined inline in per-domain conf

Name script-specific conf files with a `script##-` prefix to avoid future collisions:
`script04-…`, `script07-…`, `script052-…`.

### Rules
1. **Never write `limit_req_zone …` inline.** Always go through
   `nginx_ensure_rate_limit_zone` (primitive) or a named wrapper in the lib.
   If the zone is shared across scripts, add a named wrapper so every caller
   produces byte-identical output.
2. **Same path + same content = safe.** Multiple scripts MAY overwrite the same
   conf file as long as every caller writes byte-identical content. The named
   wrappers in the lib enforce this.
3. **Zone names must be unique across the entire nginx config.** Before adding a new zone:
   ```bash
   grep -r "zone=name_here" scripts/ lib/
   ```
4. **Test syntax after changes:** `nginx -t` before any `systemctl reload nginx`.
5. **Let's Encrypt bootstrap:** never write a vhost referencing
   `/etc/letsencrypt/live/<domain>/…` before the cert exists — `nginx -t` hard-fails
   (chicken-and-egg). Pattern (052, 07): HTTP-only vhost → reload → `certbot --nginx`
   → then write the full SSL vhost. Include `options-ssl-nginx.conf` only when the
   file exists, and never put shell syntax like `2>/dev/null` inside an nginx config.

### Anti-patterns — don't do this
**BAD — name collision:** two scripts define the same zone name with different rates/files → nginx "zone already bound" error.

**BAD — missing owner:** Script A uses `limit_req zone=grin_api` but Script B (the zone owner) hasn't run yet → "zero size shared memory zone" error.

## Generated & Temporary Files

ALL generated docs go to `docs/generated/` — never scatter into `web/`, `flowcharts/`, etc.

**Naming:** `script<XX>_<type>_<optional_service>_<optional_date>.md`
- `script<XX>` — REQUIRED prefix (e.g. `script07_`, `script04_`)
- `type` — `design`, `implementation`, `security_audit`, `analysis`, `reference`, `report`
- `date` — `YYYY-MM-DD` only when multiple versions exist

**Max 3 files per script:**
```
script##_design.md           Architecture, design decisions, schemas, API spec
script##_implementation.md   Code examples, deployment, testing, troubleshooting
script##_security_audit.md   Vulnerabilities, fixes, compliance findings
```

✅ `script07_security_pool_audit_2026-05-15.md` ✅ `script06_reference_health_endpoints.md`  
❌ `SECURITY_FIXES.md` ❌ `security_pool_audit_2026-05-15.md` (missing script prefix)

Before creating any `.md` file, check if it should be merged into an existing `script##_[type].md`. If a file becomes permanent, move it to `docs/` and drop the date.

## Script 07 — Mining Pool Architecture

**Source of truth — the pool lives in THIS repo** (2026-06): bash in
`scripts/07_grin_mining_public_pool.sh` + `lib/07_lib_hub.sh` / `lib/07_lib_satellite.sh`,
app code in `web/07_mining_pool_public/{back-end-pool,public_html}`. The standalone
**GRINIUM repo (github.com/noobvie/Grinium) was merged into the toolkit and is
deprecated — never apply fixes or mirror changes there.**

Operational facts:
- **Exclusivity:** one mining type per server — public pool XOR solo private
  (`pool_check_exclusivity` hard-blocks; they collide on nginx zones + /opt/grin layout).
  Likewise a brain (singlebox/hub) and a Satellite can't share a box (ports 3333/3334/8080).
- **No `init-db.js`:** the schema is created/migrated by `lib/db.js initDb()` every time
  the service starts — there is no separate DB-init step in the installer.
- **No `package-lock.json` yet:** the installer falls back to `npm install --omit=dev`;
  commit a lockfile in `back-end-pool/` to get reproducible `npm ci` installs.
- **Central API binds `127.0.0.1:8080`** (systemd `HOST` env) — satellites reach it only
  through the nginx HTTPS vhost (`/api/shares` + `/api/blocks`, `_ingest` rate zone), so
  satellite `hub_url` = `https://<pool-domain>`, never `:8080` directly.

Key design decisions (locked in — do not change without user confirmation):

- **Identity:** Address-as-identity (2miners style) — miner submits `grin_address.worker_name` as stratum username; no mandatory registration
- **Payments:** Tor auto-pay (default; on Tor failure, queue and retry every 6h up to 7 days) **+ an opt-in interactive Slatepack rail (re-added 2026-06).** The slatepack rail was previously dropped because the wallet owner couldn't be verified; it's now safe because the slate is emitted **encrypted to the miner's own grin address** (`create_slatepack_message` with a non-empty `recipients` list → age-encryption to that ed25519 key — the same key used as the Tor `.onion`). Only the address owner's wallet can decrypt + `receive`, so there is no theft even though miners have no accounts. Triggering a slatepack payout (and setting a per-miner payout threshold) is gated by an **IP-proof** (one of the address's last-2 mining source IPs — `lib/owner-proof.js`); this is only an anti-griefing/anti-spam throttle (shared NAT/CGNAT co-tenants can pass it), NOT the fund-safety mechanism (encryption is). Tor payouts need no IP gate (they always return to the address). Flow: `POST /api/account/:addr/withdraw {method:'slatepack'}` → armored slate → miner `receive`s → `POST …/withdraw/:id/finalize {response_slatepack}` → `finalize_tx`+`post_tx`. Unfinalized slates expire after `slatepack_ttl_hours` (default 24h), `cancel_tx` + balance reversed. Owner-API slatepack methods live in `lib/wallet.js`; state machine + expiry in `lib/withdrawal-scheduler.js`.
- **Reward model:** PPLNS (default); configurable to Proportional or Solo via admin panel
- **Block maturity:** 1440 blocks (mainnet) / 100 blocks (testnet) before payout; critical for reorg safety (Grin consensus `COINBASE_MATURITY = 1440`)
- **Orphan detection:** Nonce-based verification job every 6h; reverses payouts if a found block is orphaned
- **Race conditions:** INSERT OR IGNORE for miner auto-creation; SELECT FOR UPDATE for balance updates
- **Stack:** Node.js/Express backend (`back-end-pool/`) + static HTML/CSS/JS frontend (`public_html/`) + SQLite via Node's built-in `node:sqlite` (needs Node 24+; `lib/sqlite-compat.js` provides the better-sqlite3-style API — pragma/transaction — always require the shim, never `node:sqlite` directly in pool code); systemd process manager (not pm2). *(The early Next.js + Tailwind plan was dropped — do not reintroduce a frontend framework. better-sqlite3 was dropped 2026-06 — the pool has no native npm modules.)*
- **Auth:** Admin-only JWT sessions (bcrypt, IP allowlist, 60 min timeout); miners never need accounts.
  Login/register are gated by a **self-hosted arithmetic CAPTCHA** (`lib/captcha.js`, in-memory,
  single-use, 5-min TTL — no external reCAPTCHA/hCaptcha): `GET /api/auth/captcha` issues `{id,question}`;
  `/api/auth/login` + `/api/auth/register` verify `captcha_id`+`captcha_answer` *before* touching the
  password (a bad captcha never counts toward account lockout). Single-use → the login form re-fetches a
  challenge after every attempt. Layers on top of the auth rate limiter (3/min) + per-account lockout
  (5 fails/15 min). **nginx zone gotcha (fixed 2026-06, REVISED 2026-06):** `GET /api/auth/captcha` is
  read-only and is fetched on page load, form-toggle, and after every failed attempt — if it's throttled
  the page shows "Verification unavailable" (nginx 503 → `res.json()` throws), the "↻ new" button can't
  recover, `captcha_id` stays null, and the login POST is then rejected at the captcha gate so the operator
  **can never log in** even though the backend is fine. It needs its own `location = /api/auth/captcha`
  (exact-match wins over the `/api/auth/` prefix). **First attempt put it on `_static` (60r/m) — that was
  still wrong:** `_static` is keyed per-IP and consumed by EVERY css/js/font/image (a dozen+ per page load,
  served by `location /`), so a few page reloads during testing starve the captcha. **Fix: a DEDICATED
  `${POOL_SERVICE}_captcha` zone (30r/m)**, isolated from asset traffic. Safe because the captcha is a cheap
  in-memory challenge issue and is NOT the brute-force vector — the login POST stays on `_auth` 3r/m +
  per-account lockout + IP auto-ban. `pool_setup_nginx` self-heals an existing install: if the managed
  zone conf `/etc/nginx/conf.d/script07-<svc>.conf` lacks the `_captcha` zone it `rm`s it so the full zone
  list (incl. `_captcha`) regenerates — otherwise the no-op-if-exists helper would leave the vhost
  referencing an undefined zone and `nginx -t` fails with "zero size shared memory zone". Frontend
  `loadCaptcha()` also nulls the stale id, checks `res.ok`, and auto-retries once on a transient 503. The
  app already had the captcha on the lenient `public` (60/min) limiter — the throttle was purely the nginx
  layer. The **only** admin login page is `public_html/login.html` (served at `/login.html`,
  the public zone — must stay reachable so the operator can always authenticate); on success it redirects
  straight to `/admin/` (there is **no** `admin-dashboard.html`). The whole management surface is the one
  combined `/admin/` panel — `back-end-pool/admin-panel/{index,miners,payments,blocks,settings,users,health}.html` —
  rsynced to the nginx-gated docroot.
  **Admin panel shell — shared chrome via `admin-shell.js` (reorg 2026-06; admin-nav.js approach dropped on merge):**
  every admin page ships only its `<main>` content and loads `admin-panel/admin-shell.js` (served at
  `/admin/admin-shell.js`, load order `auth.js → api.js → admin-shell.js → page inline script`).
  **`api.js` REQUIRES `auth.js` (fixed 2026-06):** `public_html/js/api.js` (`API.get/post/...`) wraps a global
  `Auth` object defined in `public_html/js/auth.js` — every admin page that loads `api.js` MUST load `auth.js`
  first or the first `API.get()` throws `ReferenceError: Auth is not defined` (this had broken health.html's
  health/wallet/satellite cards: only settings.html loaded auth.js; health/index/blocks/miners/payments/users
  did not). All admin pages now load `auth.js` before `api.js`. admin-shell.js injects the
  left sidebar + a topbar, wraps the page `<main>` in `.admin-main`, and removes any leftover legacy chrome
  (`body > header`/`footer`/`.testnet-banner`). The old per-page top `<header>`/`nav-links` and the 5-theme
  chrome switcher were **removed**. The single `NAV` array in admin-shell.js is the source of truth for nav items:
  just TWO always-open top-level groups — **Dashboard** (▸ Miners / Payouts / Blocks / Users / System Health) and
  **Settings** (▸ the 11 settings pages + Ads). Edit `NAV` once to add/reorder. The data pages live under Dashboard
  as children; **Ads** (ads.html) sits under Settings, not as a top-level item.
  **NAV layout — flat list, NO section headers; rail only for sub-items (2026-06):** top-level items
  (`.admin-nav a`) are plain, flush-left, with a 3px transparent left border that turns accent when active — NO
  guide rail. The vertical guide line (`border-left` on `.admin-subnav`) is reserved for **nested sub-links only**
  (the Settings children), which hang off it indented so the hierarchy is obvious. The earlier uppercase section
  headers (Operations/Community/System via a `section:` field + `.admin-nav-section`) were **removed** at the
  operator's request — `section` is gone from NAV, list order is the only ordering. The Settings group is
  **NON-collapsible** (always rendered `open`, no caret). **Sidebar scroll is persisted** across the full-page
  navigations (each admin page is its own HTML file → the sidebar is rebuilt every load): admin-shell.js saves
  `.admin-nav` `scrollTop` to `sessionStorage('admin-nav-scroll')` on scroll and restores it on mount, so clicking
  a deep item (e.g. Settings → Database) no longer jumps the sidebar to the top. The topbar also carries an
  `#admin-refresh` button (`location.reload()`).
  **Admin panel facelift (2026-06):** admin accent = the pool's **atomic-green/lime brand** (`--accent:#b8e600`
  dark, darkened to `#5f7d00` light; lime buttons use dark text) so admin + public read as one product. KPI cards
  in `admin-panel/styles.css` are left-aligned with an optional `.kpi-ico` chip and a big **plain `--text`** number
  (NOT mono/accent — overrides pool.css; icon gutter only via `.kpi-card:has(.kpi-ico)`). The Dashboard
  (`index.html`) leads with a `.page-head`, the KPI row, then a 30-day pool-hashrate `.chart-card` (Chart.js,
  reuses public `GET /api/pool/hashrate/history?hours=720`, tidy `.chart-empty` fallback) — the old "Quick Actions"
  grid was dropped. `.kpi-delta` chips exist in CSS but are unused (no prior-period figure → no fake deltas).
  **Settings was SPLIT into 11 files (2026-06, replaces the old monolithic `settings.html`):** one page per
  section — `settings-pool-info.html` / `settings-branding.html` / `settings-seo.html` / `settings-analytics.html`
  / `settings-pages.html` / `settings-announcements.html` / `settings-payout.html` / `settings-incentives.html` /
  `settings-access.html` / `settings-alerts.html` / `settings-database.html`. Shared chrome/logic moved to
  `admin-panel/settings.css` (the old inline `<style>`) + `admin-panel/settings-common.js` (the old inline
  `<script>`, loaded by every settings page). Each page ships ONLY its one `.settings-content` section (forced
  visible) and declares `window.SETTINGS_SECTION='<tab>'` inline before loading settings-common.js; init is driven
  by that var (`switchTab(window.SETTINGS_SECTION)`), and builder calls are wrapped in `_safe()` so a section
  absent from the current page never throws (the settings API response always carries every section).
  `loadIncentiveData()` fires only on the incentives page. **SEO→Analytics decoupled:** `pushSeoGa4ToAnalytics()`
  can't DOM-mirror across pages anymore, so it fetches the analytics config and saves it via API (preserves
  Plausible/Umami/Matomo). The old `settings.html` is now a REDIRECT that maps legacy `#<tab>` deep-links to the
  new files. The NAV Settings entry is an EXPANDABLE GROUP whose `children` are now `{file,title}` (real pages,
  NOT `#hash` tabs); the group is open + parent active whenever `here` is the parent OR any child file
  (`onGroup()`); the old `syncActiveSubtab()`/`currentTab()` hash logic was REMOVED (active sub-link is baked at
  render). **To add a settings page:** create `settings-<tab>.html` (copy a thin page: head → `<main>` with one
  `.settings-content` + `.settings-form` → `window.SETTINGS_SECTION` → load settings-common.js) AND add a
  `children` `{file,title}` entry in admin-shell.js NAV. Layout uses `admin-panel/styles.css` `.admin-sidebar` (fixed) + `.admin-main` wrapper; `#nav-user` lives
  in the topbar and is populated by `API.guardAdminPage()`. Admin chrome theme is a Dark/Light toggle handled by
  admin-shell.js itself (storage key `admin-ui-mode` — deliberately NOT `admin-theme`, which branding.js uses for
  the public default_theme) — Matrix/Naruto/Japan dropped from admin chrome. Pages with step-up-gated actions
  (miners ban/unban, payouts retry/cancel, settings, users revoke) additionally load `/js/stepup.js` for `adminFetch`.
  **Public theme — full set RESTORED (2026-06, reverses the earlier simplification):** the Branding→Theme
  surface again offers all 13 public themes (grouped Classic/Seasonal/Fun: atomic, nexus, light, winter,
  spring, summer, autumn, halloween, christmas, galaxy, winxp, aqua, comic — defined in
  `public_html/css/themes.css` + `js/public-theme.js`) in the `#default_theme` select, PLUS the visitor
  theme-switcher: an `allow_theme_switch` checkbox + the `#enabled-themes-grid` multiselect (hidden
  `#enabled_themes` JSON input). `saveSection('branding')` serialises the ticked themes (always including the
  default) into `enabled_themes` and sends `allow_theme_switch` from its checkbox — the old "force
  `allow_theme_switch=false` + single theme" block was **removed**. The public path was always intact:
  `branding.js` calls `GriniumTheme.applyDefault(default_theme, allow_theme_switch, enabled_themes)` and
  `public-theme.js buildSwitcher()` renders a grouped `<select>` when switching is on and ≥2 themes are enabled.
  Backend `PoolSettings.THEME_KEYS` already whitelists all 13, so no validator change was needed. The Custom
  Theme Builder (`renderThemeBuilder`/`exportTheme`…) + accent-colour picker remain unused dead code (not
  re-exposed). **Logo/Slogan/SEO config is untouched** — Logo &
  Icons, App Icons, Typography, Hero/Slogan, Social (Branding tab), `pool_tagline` (Pool Info), and the whole
  SEO tab all still work.
  **GA4 in the SEO tab (2026-06):** the SEO tab has a convenience `#seo_ga_tracking_id` field (`settings-skip`,
  so the generic harvester ignores it). On SEO save, `pushSeoGa4ToAnalytics()` mirrors it into the Analytics-tab
  `#provider`/`#ga_tracking_id` and saves the **full** analytics section (`saveSection('analytics',{quiet})`) —
  so Plausible/Umami/Matomo are never clobbered and there's ONE source of truth (`analytics.ga_tracking_id`,
  which `branding.js loadGa4()` already reads). It's loaded back from the analytics config in `populateBuilders`.
  **Swinging logo unified (2026-06):** public pages now ship a static `<img class="brand-logo" src="/images/logo.svg">`
  in `.brand` (the old pulsing `.dot` span is gone), and the `brandSwing` keyframe lives in static
  `css/dashboard.css` — so the logo swings even before/without `branding.js` (fixes the homepage looking
  static). `branding.js enhanceBrand()` no longer early-returns when a `.brand-logo` exists: it repoints the src
  to a custom `logo_url` and still adds the slogan. The admin sidebar brand reuses the same `.brand-logo`+
  `brandSwing` (defined in `admin-panel/styles.css`) so public and admin match.
  **httpOnly cookie ↔ admin-page guard (CRITICAL, fixed 2026-06):** the session token is an `httpOnly`
  cookie, so **client JS cannot read or decode it** — that is the whole point of httpOnly. Admin pages must
  therefore NEVER try to decode the JWT locally to check auth. The original guard did
  `const p = API.decodePayload(); if (!p || !p.is_admin) location.href='/login.html'` — `decodePayload()`
  ALWAYS returns null with httpOnly cookies, so every admin page bounced straight to `/login.html`, and
  `login.html`'s `checkIfLoggedIn()` (which DOES work — it asks the server `/api/admin/dashboard`) bounced
  right back → **infinite flash loop; login worked but you could never stay on the panel.** Not a security
  hole (the loop was the page being *over*-strict), but a total usability break. Fix: ask the SERVER who you
  are. New endpoint `GET /api/admin/me` (secureAdmin) returns `{username,is_admin}` from `req.user`; shared
  helper `API.guardAdminPage()` in `public_html/js/api.js` calls it and wires up the `#nav-user` username +
  Logout. **It redirects to `/login.html` ONLY on a genuine auth failure (401/403) (fixed 2026-06).** It used
  to redirect on ANY non-200, so a transient 429 (app `admin` rate limit) or 503 (nginx) — common when clicking
  fast — logged the operator out mid-session even though the cookie was valid. Now 429/503/500/network are
  treated as transient (warn + stay on page). Every admin page (`index/miners/health/payments/users` inline
  guard, `settings.html` DOMContentLoaded) calls `API.guardAdminPage()` — `decodePayload()` is dead.
  Rule: to gate a new admin page, call `API.guardAdminPage()`, never decode the cookie client-side.
  **Admin rate limits raised (fixed 2026-06):** the app `admin` limiter was **10/min** — brutal for a polling
  dashboard (one page load = several `/api/admin/*` calls; health.html auto-refreshes every 30s), so it 429'd
  constantly and (with the old guard) cascaded into spurious logouts + "DB status 401"-style errors. Raised to
  **120/min** in `lib/rate-limiter.js` (still DoS-padding only — JWT + login captcha + per-account lockout + IP
  auto-ban + optional nginx allowlist are the real controls). nginx side: `/admin/` + `/api/admin/` use a
  dedicated `${POOL_SERVICE}_admin` zone (burst 40) instead of sharing the public `_static`/`_api`
  zones (a few fast clicks used to 503 `admin-shell.js` → blank sidebar). `pool_setup_nginx` self-heals the
  managed zone conf if `_admin` is missing (same pattern as the `_captcha` self-heal).
  **NOTE (2026-06): all the per-minute numbers above were subsequently multiplied ×20** (`admin` app bucket
  120→2400, `_admin` zone 120→2400r/m, etc. — see the rate-limit zone section) as a temporary "loosen now,
  tighten later" posture. The reasoning is unchanged; only the magnitudes are larger.
  **Combined health endpoint (added 2026-06):** `GET /api/admin/health` (secureAdmin) aggregates
  pool_manager/grin_node/stratum/grin_wallet/nginx/database + host `system` stats into the flat
  `{services:{key:{status,…}},system:{…}}` shape `admin-panel/health.html` renders — in ONE call (the page was
  calling this nonexistent combined route → all metrics stayed `—`; the per-component `/health/{node,wallet,
  system,satellites}` routes still exist for granular use).
  **Server-side admin gate via nginx `auth_request` (added 2026-06) — kills the "flash of admin page
  → redirect to /login.html":** the admin HTML is static-served by nginx, so the client-side
  `guardAdminPage()` redirect only fired AFTER the page rendered (a visible flash; not a data leak —
  the pages are empty shells filled by authenticated `/api/admin/*` calls, but it looked broken).
  Fix: `location /admin/` in `pool_setup_nginx` (`scripts/07_grin_mining_public_pool.sh`) now does
  `auth_request /admin/_authcheck;` + `error_page 401 403 = @admin_login;` (→ `return 302 /login.html`),
  so nginx withholds the markup until the subrequest passes. The internal `location = /admin/_authcheck`
  proxies to backend `GET /api/admin/_authcheck` (in `index.js`), gated by **`requireAdmin(authManager)`
  ONLY** — deliberately NOT the full `secureAdmin` array, so it skips the admin rate limiter (it fires
  per page AND per admin asset like admin-shell.js/styles.css; running it through the brute-force budget
  would throttle navigation). Returns 204. `guardAdminPage()` stays as a client-side fallback for
  installs whose nginx predates this block. To gate a new admin page: nothing extra — it's under
  `/admin/`, already covered. login.html staying public is correct (it's the door); the bug was that
  the admin *pages* were also public.
  login is split OUT of `/admin/` ON PURPOSE: it lives in the public
  zone (door) while the panel is IP-gated (rooms); you can't put one file in two nginx access zones. The
  old `back-end-pool/public/{login,admin}.html` duplicates were deleted 2026-06 (never deployed — the
  installer only rsyncs `public_html/` + `admin-panel/`). Do not recreate.
  **Admin nginx gate is OPEN by default (reversed 2026-06):** the network perimeter on `/admin/` +
  `/api/admin/` is a *bootstrap/testing* posture — an empty `admin_allowlist` emits `allow all;` so a
  fresh install is reachable from anywhere and the operator is never locked out while there is no
  adoption yet to attack. The app-layer defenses (JWT, login captcha, per-account lockout, IP auto-ban,
  optional TOTP, fail2ban) are ALWAYS in force regardless — this gate is only the outer perimeter.
  **Harden later** by setting `admin_allowlist` (comma/space IPs/CIDRs) in `/opt/grin/conf/grin_pubpool.json`
  and re-running 4) Setup nginx → it then locks to `localhost + listed entries; deny all;`. `/login.html`
  + `/api/auth` are always public (captcha + lockout + auto-ban + fail2ban cover them).
  **`pool_setup_nginx` allow/deny generation (`scripts/07_grin_mining_public_pool.sh`):** two branches —
  **empty `admin_allowlist` → `allow all;`** (open, the default). **Non-empty → `allow 127.0.0.1; allow ::1;`
  + each listed IP/CIDR + `deny all;`** (localhost always kept so an SSH tunnel and the app's own
  server-side calls survive — the break-glass path). There is **no** RFC1918 default and **no** SSH-IP
  auto-seed anymore (both removed in the 2026-06 reversal — the auto-seed would have flipped the empty
  default back to locked-on-one-IP). The end-of-G (`pool_guided_setup`) summary prints the public-pool +
  `/login.html` URLs and, when the allowlist is empty, an "OPEN to all — harden later" note; when it's
  non-empty, the currently-allowed IPs + a copy-paste `node -e` command to add your **browsing** IP
  (which can differ from your SSH IP — the usual 403 cause) before re-running 4) Setup nginx.
- **Admin-panel hardening (added 2026-06) — three layers:**
  1. **Step-up (re-auth) on money/destructive/access-control actions.** `freshAdmin` middleware =
     `secureAdmin` + `requireFreshAuth` (5-min window). Gated endpoints: `POST /api/admin/incentives/award`,
     `…/prize-pool/topup`, `…/lottery/draw-now`, `…/database/cleanup`, `…/settings/:section/restore`,
     `…/poolstats/update-key`, `…/security/ip-allowlist/{add,remove}`, `…/security/ip-blacklist/{add,remove}`,
     `DELETE …/locations/:id`. Plus `POST …/settings/:section` requires step-up **only** for the high-risk
     sections `payout` + `access` (checked inline via `authManager.isTokenFresh`; cosmetic sections save
     with a normal session). `saveSection`/`restoreSection` in settings.html use `adminFetch`.
     Freshness is keyed on a NEW `pwa` (password-verified-at) JWT claim, **not `iat`** — a silent
     `/api/auth/refresh` mints `pwa=0` so it can't grant step-up; only `login` and the new
     `POST /api/admin/reauth` (→ `AuthManager.stepUp`) set `pwa=now`. Frontend: `public_html/js/stepup.js`
     `adminFetch()` catches `403 {challenge_required:true}`, prompts for the password, calls reauth,
     retries once. Wired into the risky calls in `admin-panel/settings.html` (loads `/js/stepup.js`).
     To gate a new risky endpoint: use `freshAdmin` server-side + `adminFetch` client-side.
  2. **Auto-ban repeat offenders.** In `index.js`: ≥10 failed admin logins from one IP within 15 min →
     `ipFilter.tempBan(ip, 1h)` (new in-memory TTL ban in `lib/ip-filter.js`; `isBlocked()` checks it).
     The login route rejects banned IPs up front and clears the counter on success. App-layer; complements
     the OS-level `pool_setup_fail2ban` (firewall ban) already in the installer.
  3. **Admin panel network gate (nginx) — OPEN by default (reversed 2026-06).** `pool_setup_nginx`
     emits `location /admin/` + `location /api/admin/` from the `admin_allowlist` conf key: **empty →
     `allow all;`** (testing default — reachable from anywhere, since layers 1/2 + login still gate it);
     **non-empty → `allow 127.0.0.1; allow ::1;` + listed IPs/CIDRs + `deny all;`** (hardened). No RFC1918
     default, no SSH auto-seed (removed). `/api/auth` (login) is always public — covered by
     captcha+lockout+auto-ban+fail2ban. Harden: set `admin_allowlist` in `/opt/grin/conf/grin_pubpool.json`,
     re-run 4) Setup nginx.
- **Optional admin TOTP 2FA (added 2026-06).** Self-hosted RFC 6238 (`lib/totp.js`, SHA-1/6-digit/30s,
  base32 — verified against the RFC test vectors), **no npm dependency, no external service**. Per-admin,
  opt-in. State on the `users` table (`totp_secret`, `totp_enabled`, `totp_pending_secret`); one-time
  backup codes in `admin_recovery_codes` (bcrypt-hashed, single-use).
  - **Two-step login:** `POST /api/auth/login` (password + CAPTCHA) → if `totp_enabled`, returns
    `{ totp_required:true, twofa_token }` (short-lived JWT `type:'2fa'`, 5 min, no session yet) instead of
    a cookie → `POST /api/auth/login/totp` { twofa_token, code } verifies a TOTP **or** a recovery code
    and issues the session (no second CAPTCHA). Failed 2FA codes count toward the IP auto-ban.
  - **Management (settings.html → Access Control, all step-up `freshAdmin`):** `GET /api/admin/2fa/status`,
    `POST …/2fa/enroll/begin` (returns secret + otpauth URI; manual key + tap-link shown, QR rendered only
    if a `window.qrcode` lib is bundled), `…/2fa/enroll/confirm` (verify a live code → enable + return
    recovery codes once), `…/2fa/disable` (needs a code), `…/2fa/recovery/regenerate` (needs a code).
    `auth.js`: `begin2faEnrollment`/`confirm2faEnrollment`/`disable2fa`/`verifyTotpOrRecovery`/
    `generateRecoveryCodes` (async — avoids blocking the shared stratum/API event loop) /
    `generate2faToken`/`verify2faToken`/`issueSessionFor`.
  - **Recovery if the authenticator is lost:** (1) one of the 10 backup codes; (2) **root reset on the
    server** (you own the box — this is the ultimate, unloseable fallback). Run against the pool DB:
    `UPDATE users SET totp_enabled=0, totp_secret=NULL, totp_pending_secret=NULL WHERE username='<admin>';`
    then `DELETE FROM admin_recovery_codes WHERE user_id=(SELECT id FROM users WHERE username='<admin>');`
    (DB at `/opt/grin/pubpool/mainnet/pool.db`; use the `node:sqlite` shim, not the optional sqlite3 CLI).
- **Access Control admin tab (settings.html) is wired to the LIVE app-level ipFilter** (added 2026-06):
  `GET /api/admin/security/ip-filter-status` (returns entries + `your_ip` for a self-lockout warning) +
  the step-up-gated `ip-allowlist/{add,remove}` & `ip-blacklist/{add,remove}` via `adminFetch`. These are
  **runtime-only** (ipFilter in-memory; reset on restart — a deliberate break-glass escape from a bad
  allowlist). Permanent rules still live in config: `admin_ip_allowlist` (app) + `admin_allowlist` (nginx).
  The tab loads on open (`switchTab('access') → loadIpFilter()`).
- **Admin operations features (added 2026-06) — payout/ledger/blocks/moderation tooling.** Seven
  operator tools were added on top of the existing panel. All money/destructive ones are step-up
  gated (`freshAdmin` + `adminFetch`); read-only ones are `secureAdmin`:
  - **Payout queue control** — `POST /api/admin/withdrawals/:id/retry` + `…/cancel` (freshAdmin).
    Retry re-queues a `retry_scheduled`/`tor_failed` payout (a `tor_failed` one is **re-locked**
    first via CAS `balance>=amount`, since `markFailed` already reversed locked→balance — skipping
    that would double-spend the ledger). Cancel refunds locked→balance for `retry_scheduled`/
    `tor_checking` (sets status `cancelled`, fills the pre-existing `withdrawals.cancelled_by`/
    `cancel_reason` cols); a `tor_failed` cancel only records the cancel (funds already returned).
    `tor_sending` is never actionable (in flight). UI: rewritten `admin-panel/payments.html`
    (filter chips by real status, Retry/Cancel buttons) — the OLD payments.html was **stale**
    (hit a nonexistent `/pay`, used `tx_slate_id`/`username`/`waiting_finalize` that aren't in the
    real schema).
  - **Wallet↔ledger reconciliation** — `GET /api/admin/reconciliation` (secureAdmin): compares
    on-chain `wallet.getBalance()` total vs. ledger owed (Σ`balance`+Σ`balance_locked` over
    miner_accounts, incl. prize bucket). `coverage_gap = wallet.total − owed` (<0 = under-funded);
    `locked_drift = Σbalance_locked − Σ(pending withdrawal amounts)` (should be ~0). Surfaced as a
    card on `health.html`. The single most important custodial safety check.
  - **Pool blocks explorer** — `GET /api/admin/blocks?status=&limit=&offset=` (secureAdmin) + NEW
    page `admin-panel/blocks.html` + a "Blocks" entry in the `admin-shell.js` `NAV` array.
    Pool-found blocks only, with maturity countdown (`confirm_depth − (tip−height)`; tip from
    `blockMonitor.grinNode.getStatus().height`) + a **GrinScan deep-link per block**
    (`grinscan.org/block/<height>`, testnet→`testnet.grinscan.org`). Distinct from GrinScan (06b),
    which is the whole-chain explorer and can't know pool payout/orphan context. Summary KPIs come
    from `blockManager.getPoolStats()` (the standalone `blockManager`, NOT `blockMonitor` — that has
    only `grinNode`/`orphanDetector`).
  - **Per-miner ban (moderation)** — `miner_accounts` gained `is_banned`/`ban_reason`/`banned_at`
    (additive `migrateMinerAccounts()` in db.js, + columns on the CREATE TABLE). `miners.js`
    `isBanned()`/`banMiner()`/`unbanMiner()`; **stratum `handleLogin` rejects a banned address
    before creating a session** (and `banMiner` drops live sessions). Balance is deliberately KEPT
    on ban so owed GRIN can still pay out. Endpoints `POST /api/admin/miners/:addr/ban|unban`
    (freshAdmin). UI: rewritten `miners.html` (also stale before — `/api/admin/miners` returns
    `{miners:[…]}` with `grin_address`, not the old `m.worker`/array shape).
  - **Admin sessions / login activity** — sessions are stateless JWTs (no session table), so there's
    no per-device list. `GET /api/admin/security/login-history` (from `admin_audit_log`
    login_success/failure/ip_autoban/logout) + `POST /api/admin/security/revoke-sessions`
    (freshAdmin → `authManager.revokeUserTokens` bumps `token_version`). **Honest limitation:** the
    auth middleware verifies only the JWT signature, NOT `token_version` per request, so revoke kills
    refresh tokens but live access tokens persist up to their 1h TTL. UI panel on `users.html`
    (which is otherwise stale — `/api/admin/users` has no backend route; admin-user CRUD was never
    built).
  - **Notification delivery: Telegram + test** — email/Discord/Slack already existed in
    `lib/alert-delivery.js`; added a **Telegram** channel (Bot API `sendMessage`, reads
    `config.telegram_bot_token`/`telegram_chat_id`) + `configuredChannels()`. `POST
    /api/admin/alerts/test` (secureAdmin) fires a synthetic alert through the live channels. Alert
    channels are sourced from the running `config` (pool.json), **not** the `alerts` settings
    section (the section's webhook/email keys are informational unless wired into config — a
    pre-existing disconnect). Telegram fields + "Send test alert" button added to the settings
    Alerts tab; `telegram_bot_token`/`telegram_chat_id` added to the `alerts` settings defaults.
  - **Financial export (CSV)** — `GET /api/admin/export/payouts.csv` (confirmed withdrawals) +
    `…/fee-revenue.csv` (per-block pool cut = `reward × pool_fee_percent`, derived not stored), both
    secureAdmin. Plain `<a href>` download links (same-origin sends the httpOnly cookie) on
    payments.html.
  - **Already-built, untouched:** maintenance mode (notices section + Announcements tab) was fully
    present; satellite heartbeat health is read-only on health.html (secret rotation stays
    config-level: `hub_shared_secret` in `grin_pubpool.json`/`grin_satellite.json` + restart).
  - **Ads (operator promotions, added 2026-06).** New `ads` table (created/migrated by `db.js initDb`,
    no separate step) + `lib/ads.js` (`AdsManager`, positional-param SQL like the rest of the codebase).
    Two kinds: **banner** (`image_url`+`link_url`+`alt_text`) or **code** (raw operator-trusted HTML/JS
    snippet — e.g. a Coinzilla/A-ADS zone), bound to one of 4 **placements** (`header`/`sidebar`/
    `in-content`/`footer`) with `is_active`, `weight` (higher first), and an optional `start_at`/`end_at`
    window. Admin CRUD `GET/POST /api/admin/ads`, `POST /api/admin/ads/:id`, `DELETE /api/admin/ads/:id`
    are **secureAdmin** (NOT freshAdmin — ads don't move funds). Public read `GET /api/public/ads`
    (`?placement=` for one slot, else all keyed by placement) returns only active, in-window ads with
    just render fields. Admin UI: new `admin-panel/ads.html` (banner/code toggle form + table; looks up
    rows from a `_ads` array by id rather than inlining objects into onclick attrs — avoids quote-escaping
    bugs in code snippets). It's a **child of the Settings** NAV group (a content/monetization page alongside
    Pages/Announcements), reachable at `/admin/ads.html` — NOT a settings *section* (it's standalone CRUD, not
    part of settings-common.js).
    **Public rendering:** `public_html/js/ads.js` fills every `[data-ad-slot="<placement>"]`; `public-shell.js`
    injects header+footer slots **site-wide** and dynamically loads `ads.js`; the homepage `index.html` adds
    `sidebar`+`in-content` slots. Code-snippet `<script>` tags are re-created so ad-network zones actually run
    (innerHTML won't execute them). Empty slots stay `display:none`. Styles: `.ad-slot*` in `css/dashboard.css`.
    Banner links get `rel="noopener nofollow sponsored"`.
  **No miner accounts — reaffirmed 2026-06.** An optional miner-account layer (`miner_users` table,
  signup bonus, public Sign In/Register) was prototyped then deliberately removed: it adds operator
  burden with no safety gain (the address already IS the identity, and payouts are permanently bound
  to the mining address — `withdrawal.grin_address`, never an account-settable field, so there is no
  redirection/theft vector to protect). Do NOT reintroduce miner accounts without explicit user
  confirmation. Public pages therefore have **no Sign In button** — admins reach `/login.html` by
  direct URL only.
- **Prizes/incentives go straight to the address.** Instead of accounts, the operator awards a
  contest/incentive prize directly to a Grin address via admin `POST /api/admin/incentives/award`
  → `IncentivesManager.awardPrize(address, amount, {fromPrizePool=true})` (lib/incentives.js): credits
  `miner_accounts.balance` (reference_type `prize_award`), funded from the `prize_pool` bucket by
  default (rejects with `insufficient_prize_pool` if the bucket can't cover it; pass
  `from_prize_pool=false` to mint when the wallet already holds the GRIN). The prize pays out via the
  normal Tor withdrawal flow. UI: admin Settings → Incentives → "Award Prize / Bonus to an Address".
  Human-readable note is stored in `admin_audit_log`, not `balance_log`.
- **Config:** Stored in `/opt/grin/conf/grin_pubpool.json`; all settings via web admin panel — no bash config files
- **Paths (renamed 2026-06 to the product-prefixed "pubpool" family):** app+DB `/opt/grin/pubpool/mainnet/`, wallet `/opt/grin/pubpoolwallet/mainnet/`, wallet password `/opt/grin/pubpool/mainnet/.wallet_pass` (600, deliberately separate from the seed dir). Legacy `/opt/grin/pool` + `grin_pool.json` are recognised by Z) Cleanup and the hub detector but never written.
- **Script 07 role:** Infrastructure only (deploy files, systemd services, backups); business logic lives in pool web code
- **Networks:** the public pool is a mainnet-only product (the earlier "testnet stratum-only mode" plan was not implemented); testnet mining is done via `07_grin_mining_solo.sh`
- **Default pool fee 1.0%** (`pool_fee_percent: 1.0`, validated 0–50); min withdrawal: 5.0 GRIN
- **Per-miner payout threshold:** `miner_accounts.min_payout` (NULL = pool default). Acts as that address's personal minimum-withdrawal floor in `createWithdrawal` (the pool has no auto-payout loop — payouts are miner-initiated). Can only be RAISED above `config.min_withdrawal`, never below. Set via the IP-gated `POST /api/account/:addr/min-payout`.

### Public miner-facing endpoints (added 2026-06 — grin-pool parity)

All public (no admin auth), `rateLimiter.middleware('public')`:
- `GET /api/account/:addr/workers` — per-worker (rig) breakdown. Hashrate/share-count/last-share from the `shares` table (all regions, survives restarts); **reject% / stale% + online come from the LIVE in-memory stratum sessions on the box serving the request** (`minerManager.getSessionsByMiner`). **Hub-mode limit:** satellites relay only *accepted* shares, not reject/stale counters, so on a hub these columns reflect only locally-connected workers — documented, not a bug.
- `GET /api/account/:addr/hashrate/history?hours=24` and `GET /api/pool/hashrate/history?hours=24` — time-series from `hashrate_history` (per-address per-minute samples; pool series = `SUM` per bucket), downsampled. Charted with **Chart.js vendored at `public_html/js/vendor/chart.umd.min.js`** (no CDN) via `js/charts-init.js` (`PoolCharts.renderHashrateChart`).
- `GET /api/pool/effort` — `round_effort_pct` (Σ share diff since last block ÷ current per-block network diff), `luck_100_pct` (mean of `network_difficulty/round_shares` over last 100 blocks), `seconds_since_last_block`. Backed by additive `blocks.network_difficulty` + `blocks.round_shares` captured at find time in `lib/blocks.js creditBlock` (needs `blockManager.setNodeApi(blockMonitor.grinNode)`); current net diff cached ~60s on `app.locals`.
- `GET /api/account/:addr` now also returns `min_payout`, `effective_min_payout`, `has_recorded_ip`.

**Miner source-IP capture (backs the ownership gate):** recorded into `miner_accounts.last_ip/prev_ip` (last-2 distinct, shift on change) via `minerManager.recordSourceIp` → `owner-proof.recordSourceIp`. Captured at stratum login locally; **in hub-and-spoke the satellite relays the miner IP per-share** (`source_ip` added to the relayed share object in `stratum-server.js`; `share-relay.js` forwards it verbatim incl. failover replay; hub `POST /api/shares` uses `s.source_ip`, NOT `req.ip` which is the satellite). UI: all per-account features live on `account-settings.html` (chart, workers, threshold, slatepack); pool chart + effort row on `index.html`. **Payout method is single-select (2026-06):** the Withdraw section has a Tor/Slatepack radio group (`name="acct-pay-method"`, Tor default) and `syncPayMethod()` shows only the selected pane (`#acct-pay-tor-pane` / `#acct-pay-slatepack-pane`) — both rails still hit `POST /api/account/:addr/withdraw {method}` gated by the IP-proof (one of the last-2 mining IPs). The nav link + page `<h2>` say "Account" (renamed from "My Account").
- **Public chrome = `public_html/js/public-shell.js` (single source of truth, added 2026-06 — the
  public mirror of `admin-shell.js`).** Every public page (all 7 that share the site header:
  index, miners-stats, payment-history, account-settings, fortune-board, donate, page) now ships
  ONLY its content (`<div class="wrap">`/`.container`) and an `<!-- header/footer injected by
  /js/public-shell.js -->` marker; the `<header>` (brand + nav + `.theme-switcher` + "Start Mining")
  and `<footer>` are injected SYNCHRONOUSLY at body-end by public-shell.js, so the chrome is
  byte-identical across pages with no flash. **The `NAV` array in public-shell.js is the ONE source
  for the public nav** — edit it once to add/rename/reorder a link. Load order on every page:
  `public-shell.js → public-theme.js → branding.js` (shell first so `.theme-switcher`/`.header-nav`
  exist before the other two run). **Why the earlier centralization "didn't help":** branding.js USED
  to own a `NAV_LINKS` list + `buildNav()` that rewrote each page's *hardcoded* `<header>` nav AFTER
  the async `/api/config` fetch — so until that resolved you saw each page's drifting hardcoded
  fallback nav (and the surrounding header/footer markup was still duplicated in 7 files). `NAV_LINKS`
  + `buildNav` were REMOVED from branding.js; it now only ENHANCES the injected chrome (logo/slogan via
  `.brand`, `[data-brand]` hooks, and the incentives-gated `injectRewardsLink` 🎁 Rewards link — which
  still inserts before the `account-settings.html` nav link). `login.html` is intentionally NOT
  converted (standalone admin door, no site header). To change the public header/footer or nav: edit
  public-shell.js, never re-add per-page `<header>`/`<footer>`.
- **Public page set consolidated 2026-06 — 8 pages in `public_html/`:** `index.html` (dashboard +
  connect + info), `miners-stats.html`, `payment-history.html`, `account-settings.html`,
  `fortune-board.html`, `donate.html` (last two = incentives), `login.html` (admin door, public zone),
  and `page.html` (generic renderer for operator-authored pages via `/page.html?p=<key>`; footer
  links + the SITEMAP authored-pages come from `poolSettings.listEnabledPages()`). **Deleted:**
  `connect.html` + `pool-info.html` (merged into the dashboard `#connect` / `#info` anchors),
  `home-classic.html` (orphan dup of index), `grin_mining_testnet_instruction.html` (testnet on a
  mainnet-only product — testnet lives in the solo script), `system-health.html` +
  `admin-dashboard.html` (the gated `/admin/` panel is the sole admin surface; login → `/admin/`).
  When removing/renaming a public page, fix the backend `SITEMAP_PATHS` in `index.js` and the
  `NAV` array in `public_html/js/public-shell.js` (single nav source — see next bullet). **`sitemap.xml` / `robots.txt` / `manifest.json` are
  served dynamically by the backend** (`index.js` routes, nginx `location = /…` proxies those three
  exact paths to Node) — there are **no** static copies in `public_html/` (the stale shadowed
  duplicates were deleted 2026-06). Do not recreate them; edit the generators in `index.js` instead. The merged dashboard **#info** section ports pool-info's Rules/payouts + Support
  (social hooks auto-managed by branding.js; `loadInfoContact()` toggles the email row + "no
  channels" note, which branding.js doesn't).
- **Public homepage (index.html) surfaces, added 2026-06:**
  - **Regional stratum cards (the connect surface) — on the DASHBOARD (`index.html`), not a
    separate page.** `connect.html` was **deleted 2026-06** as redundant: its per-miner CLI command
    generator (lolMiner/GMiner/SRBMiner) was misleading for the common case (G1/iPollo ASICs are
    configured via their own web UI, not a CLI). All "Start Mining" buttons + the header nav now point
    to `index.html#connect`. The dashboard's "Point your miner at your nearest region" section
    (`#connect`) renders **one card per region** (all visible at once) showing `host:port` + a **live
    up/down pill** + active-miner count, with a Copy button; below the grid a single shared
    `.connect-note` gives the connect fields (worker = `grin_address.worker`, password = anything —
    same for every region, port identical across regions). `loadRegions()` reads `GET
    /api/pool/stats/regions` and re-polls on the 60 s dashboard refresh so pills stay live; it filters
    to active rows with a `stratum_url`. **The multi-region grid renders only when ≥2 regions exist**
    (`loadRegions()`: `if (regions.length < 2) keep fallback`); a single-server pool shows the simple
    `#region-fallback` "point your miner here" callout instead of a lone 1-card grid. The pill
    `status` (`online`/`stale`/`offline`/`unknown`) is derived from the in-memory satellite heartbeat
    with a recent-shares fallback (`unknown` = no signal yet, shown neutral — never a false "down").
    To make this truthful for a *quiet* region, the satellite `lib/share-relay.js` POSTs an **empty
    idle heartbeat** (`{region, shares:[]}`) to `/api/shares` every `HEARTBEAT_MS` (60 s) when there
    are no shares to flush, so a healthy-but-empty region reads `online` instead of `offline`.
    **No demo regions are seeded (2026-06):** the old `db.js seedDefaultRegions()` (fake
    amer/euro/asie.grinium.com cards on every install) was removed — it showed phantom regions on a
    single-server box. Instead the pool server **self-registers its own region** via
    `db.js ensureLocalRegion(region, stratumUrl)`, called from `index.js` startup **only when
    `config.role === 'singlebox'`** (a bare hub runs no local stratum → relies purely on satellites).
    It inserts ONE `pool_locations` row for `config.region` (bash default `"main"`, in
    `pool_ensure_defaults`), `stratum_url = subdomain:stratum_port` (config.js now passes `subdomain`
    through; backfilled on a later boot if subdomain was empty at first run), never clobbering an
    operator's label/active/url edits. So the central box is an honest region that **auto-joins the
    grid the moment a real satellite for another zone reports in** — the seamless single→multi path.
    Extra zones come from real satellites the operator declares in admin → Regions, never seed data.
  - **Service status strip** — public `GET /api/pool/status` (rate-limited, 15s cache) returns
    coarse health only: `pool.ok`, `node {reachable,synced,peers,height}`, `wallet {reachable}`.
    **Never** exposes wallet balance/addresses (those stay on admin-only `/api/admin/health/*`).
  - **Branding/header** — `js/branding.js enhanceHeader()` runs site-wide (every page that has a
    `.brand`): swaps the `.dot` for the swinging atomic-green logo (`#b8e600→#7a9700`, CSS keyframe
    `brandSwing`, ~80° pendulum pivoting near the top, respects `prefers-reduced-motion`), adds the
    slogan (`pool_tagline`, default "Mine Grin, anywhere") under the wordmark, and injects a
    `🎁 Rewards` nav link → `fortune-board.html` when incentives are enabled. Footer sub-brand is
    "GRINIUM — Grin Mining Pool" (was "Uranium Element…").

### Content CMS — dynamic Pages + Blog Posts + media uploads (added 2026-06)

Replaced the old **fixed 5-slot `pages` config section** (about/terms/privacy/faq/impressum as raw-HTML
textareas in settings) with a small WYSIWYG CMS, modelled on the existing **ads.js + ads.html** CRUD
pattern. Two content types, one shared editor:

- **Pages** (static, standalone) — dynamic `pages` table (`slug` UNIQUE, `title`, `html`, `is_published`,
  `nav_location` footer|header|none, `sort_order`, `seo_title/desc`). `lib/pages.js` `PagesManager`
  (CRUD + `getPublic(slug)`, `listEnabled()`). Served at `/page.html?p=<slug>` (renderer unchanged — it
  always took an arbitrary key). Admin CRUD page **`admin-panel/pages.html`** (replaced settings-pages.html,
  which was DELETED). **Migration:** `db.js migratePagesFromConfig()` runs once while the table is empty —
  seeds the 5 legacy slugs from the old `pool_config` 'pages' section (empty ones become unpublished drafts),
  so nothing breaks. `pool-settings.js getPage()`/`listEnabledPages()` were **repointed to read the `pages`
  table** (single source of truth) — `listEnabledPages()` (footer links via `/api/config`) excludes
  `nav_location='none'`; `PagesManager.listEnabled()` (sitemap) also excludes `none`. The old config `pages`
  section + `pageTitles` stay in pool-settings.js only as the migration seed source.
- **Posts** (dated blog/announcements — WordPress "Posts") — `posts` table (`slug`, `title`, `body_html`,
  `excerpt`, `cover_image`, `tags`, `status` draft|published, `published_at`). `lib/posts.js` `PostsManager`
  (`listPublished({limit,offset})` paginated, `getPublic(slug)`, CRUD; auto-excerpt from body, auto-stamps
  `published_at` on first publish). Admin CRUD **`admin-panel/posts.html`** ("Blog" in NAV). Public:
  **`public_html/blog.html`** (paginated card list) + **`post.html?slug=`** (permalink) + RSS at
  **`/blog/rss.xml`** (app-generated; nginx exact-match proxy). "Blog" added to `public-shell.js` NAV;
  `/blog.html` + posts added to the sitemap.
- **Editor: vendored Quill 2.x** at `public_html/js/vendor/quill.js` + `quill.snow.css` (committed +
  rsynced, same as Chart.js — no CDN, no build). Shared init helper **`admin-panel/cms-editor.js`**
  (`CmsEditor.mount('#editor')` → `{getHTML,setHTML}`; `CmsEditor.uploadImage(file)`). **No image ever
  enters the document as base64**: the toolbar image button, clipboard **paste** of an image file, and
  drag-**drop** are all intercepted (paste/drop in the capture phase, before Quill's own base64 handler)
  and UPLOADED to `/uploads`, inserting only a short URL. So the DB stores post HTML with `<img src="/uploads/…">`,
  never image bytes — which is why the engine stays SQLite (a few KB of HTML per post; MariaDB/Postgres would
  not help and the hub is deliberately single-writer SQLite/WAL). Quill HTML is operator-trusted, rendered
  via `innerHTML` (same trust model as ad code snippets). *(Edge case: an image pasted as part of copied
  HTML containing a `data:` URL is not converted — rare; the common screenshot/file paste IS uploaded.)*
- **Media uploads** — `POST /api/admin/media` (secureAdmin, multer single `file`, 5 MB, JPG/PNG/GIF/WEBP/SVG)
  → returns `{url}`. Stored in **`$POOL_APP_DIR/uploads/`** (= `path.dirname(db_path)/uploads`), **OUTSIDE
  public_html** so the installer's `rsync --delete` of the docroot never wipes media. Served at `/uploads/`
  by **nginx `location /uploads/` (alias, nosniff + sandbox CSP, 7d immutable)** in prod, with an
  `express.static('/uploads')` fallback in the app for dev. `pool_setup_nginx` pre-creates the dir with
  `chmod o+rx`; the app also `mkdirSync`s it at boot.
- **All admin CMS routes are `secureAdmin`** (content, not funds — NOT freshAdmin): `/api/admin/{pages,posts,media}`.
  Public reads (`/api/public/{page/:key,pages,posts,post/:slug}`, `/blog/rss.xml`) are `public` rate-limited.
  To add a content type: clone the ads.js manager + table + the `admin-panel/*.html` CRUD page, add it to the
  `admin-shell.js` NAV Settings `children`, and wire public routes.

### Multi-region — hub-and-spoke (design: `docs/generated/script07_design.md` §3–4)

Script 07 has three deployment **roles** internally (`singlebox|hub|satellite`), but the interactive
`pool_select_mode` menu was **consolidated to two options (2026-06)** to stop forcing a topology
choice on a newcomer — there is no "central vs distributed" fork; distributed *is* central + N
satellites:
- **1) Pool server** → `singlebox`. The pool itself — the brain + a co-located local stratum. It IS a
  full hub (runs the Central API + `/api/shares` ingestion), so it accepts remote satellites later with
  zero changes to itself. Start here for any single-box install.
- **2) Satellite agent** → `satellite`. An extra region on **another** box; node + stratum proxy + relay,
  **no** web/admin/DB/wallet. Sourced from `lib/07_lib_satellite.sh`. Config: `/opt/grin/conf/grin_satellite.json`.
- **`hub`** (Central Hub only — brain with **no** local stratum, satellites do all mining) is an
  **advanced** role: dropped from the menu but still reachable as a launch arg
  (`bash 07_grin_mining_public_pool.sh hub`). Sourced from `lib/07_lib_hub.sh`; reuses the shared
  `pool_*` setup functions. A `singlebox` already ⊇ `hub`, so bare hub is only for offloading mining off
  the central box at scale. All three roles may still be passed as `$1` for non-interactive launches.

**Add-a-zone workflow** (central → distributed, no rebuild of the central box): (1) admin → Regions →
declare the region (name + label + that zone's stratum URL); (2) on the new box run option 2 and enter
region name + hub URL + shared secret. The card lights up live from the satellite's heartbeat.

Locked decisions (do not change without user confirmation):
- **Database stays SQLite (WAL), not Postgres.** The hub is **single-writer** — only the Central API process writes; satellites POST over HTTPS, they never touch the DB. Migrate to Postgres only if the Central API itself goes multi-process/replicated, the DB moves to a separate box, or hot un-prunable data exceeds ~20–50 GB. Adding satellites does NOT change this (a region is a new HTTP client, not a new DB writer).
- **Share capture = own stratum proxy** in front of the node's built-in stratum (grin-pool model) — NOT log-tailing. Gives structured `address.worker` identity + per-miner vardiff. Built-in stratum binds localhost `:3334`; proxy binds public `:3333`.
- **Satellite→Hub transport** — `POST /api/shares` (batched) + `/api/blocks` (block-found) to Central API `:8080`; IP-allowlist + shared-secret header over HTTPS (mTLS later). Relay buffers to a local SQLite failover file on Hub outage and replays.
- **Retention** — raw shares kept only for the PPLNS window then pruned; hashrate downsampled 5m→1h→1d; financial rows kept forever. Configurable in the admin panel (Database / Cleanup); job is `retention.js` on a systemd timer. ~300–600 MB after year 1 for ~1000 miners, ~30 MB/yr after.
- **Runtime** for proxy + relay: Node.js 24+ (`node:sqlite` via the same `sqlite-compat.js` shim for the failover buffer).

## Debugging — Confirm Root Cause Before Editing
When a bug or error is reported, **confirm the root cause with evidence before changing
code.** A plausible-looking suspect is not a confirmed cause.

- Ask the operator to run diagnostics and read the *actual* output first. Propose specific
  commands, wait for results, and let the evidence point to the cause.
- Don't jump from a guess (a suspicious commit, a recent change) straight to an edit. State
  your hypothesis, then verify it before touching code.
- Make sure each diagnostic actually proves what you think — a test that can't observe the
  thing you're checking is not evidence.
- "It worked before" often means a different environment or input, not a code regression —
  rule that out before blaming a change.
- Only once the cause is confirmed, make the **smallest** fix at the true source rather than
  adding compensating logic elsewhere.

## Do Not
- Never run toolkit scripts locally — they assume a Linux VPS with root access
- Never hardcode wallet API secrets or passwords in scripts
- Never skip `bash -n` syntax check before committing a shell script change
- Never use `--floonet` — the correct testnet flag is `--testnet`
- Never mix mainnet and testnet ports or directories
- Don't add `#!/bin/bash` to lib files — they are sourced, not executed
