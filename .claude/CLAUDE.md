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
# In Script 07 (public pool) — actual call:
nginx_ensure_rate_limit_zones "script07-${POOL_SERVICE}" \
    "${POOL_SERVICE}_auth:3r/m"  "${POOL_SERVICE}_api:30r/m" \
    "${POOL_SERVICE}_static:60r/m" "${POOL_SERVICE}_ingest:120r/m"
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
- `${POOL_SERVICE}_auth/_api/_static/_ingest` (Script 07 only) — written via the multi-zone helper; `_ingest` covers satellite `/api/shares` + `/api/blocks` so relay batches aren't throttled by the public `_api` zone
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
- **Payments:** Tor-only auto-pay; slatepack interactive flow dropped entirely; on Tor failure, queue and retry every 6h up to 7 days
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
  (5 fails/15 min). The **only** admin login page is `public_html/login.html` (served at `/login.html`,
  the public zone — must stay reachable so the operator can always authenticate); on success it redirects
  straight to `/admin/` (there is **no** `admin-dashboard.html`). The whole management surface is the one
  combined `/admin/` panel — `back-end-pool/admin-panel/{index,miners,payments,settings,users,health}.html` —
  rsynced to the nginx-gated docroot. login is split OUT of `/admin/` ON PURPOSE: it lives in the public
  zone (door) while the panel is IP-gated (rooms); you can't put one file in two nginx access zones. The
  old `back-end-pool/public/{login,admin}.html` duplicates were deleted 2026-06 (never deployed — the
  installer only rsyncs `public_html/` + `admin-panel/`). Do not recreate.
  **403 on `/admin/` is by design, not a bug:** the nginx `admin_allowlist` keeps the admin panel off
  the public internet. Reach it via LAN/VPN/SSH-tunnel, or set `admin_allowlist` in
  `/opt/grin/conf/grin_pubpool.json` and re-run 4) Setup nginx. `/login.html` + `/api/auth` stay public
  on purpose (captcha + lockout + auto-ban + fail2ban cover them).
  **`pool_setup_nginx` allow/deny generation (`scripts/07_grin_mining_public_pool.sh`):**
  `127.0.0.1` + `::1` are **always** emitted in both branches (an SSH tunnel arrives as localhost, plus
  the app's own server-side calls) — never lock out the break-glass path. Empty `admin_allowlist` →
  localhost + RFC1918 (10/8, 172.16/12, 192.168/16). Non-empty → localhost + the listed IPs/CIDRs only
  (LAN is dropped — set it explicitly if you still want it). **First-run SSH-IP auto-seed:** when the
  allowlist is empty, the function detects the operator's SSH client IP (`$SSH_CONNECTION`→`$SSH_CLIENT`,
  skipped for local/RFC1918 sources) and **auto-writes** it into `admin_allowlist` (no prompt — just a
  yellow `warn` announcing it) so they can reach `/admin/` from the install machine immediately (solves
  the chicken-and-egg). One-time — once the conf is non-empty it's skipped. NOT defaulted to allow-all: the secure default fails closed; the
  seed adds exactly one trusted IP rather than opening the panel to the internet. The end-of-G
  (`pool_guided_setup`) summary prints the public-pool + `/login.html` URLs, the currently-allowed
  admin IPs, and a copy-paste `node -e` command to add your **browsing** IP (which can differ from
  the seeded SSH IP — the usual cause of a 403 on `/admin/`) before re-running 4) Setup nginx.
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
  3. **Admin panel off the public internet (nginx).** `pool_setup_nginx` emits `location /admin/` +
     `location /api/admin/` with `allow … ; deny all;` built from the `admin_allowlist` conf key
     (comma/space-separated IPs/CIDRs). Empty = localhost + RFC1918 only (reach via LAN/VPN/SSH-tunnel).
     `/api/auth` (login) stays public on purpose — it's covered by captcha+lockout+auto-ban+fail2ban.
     Widen access: set `admin_allowlist` in `/opt/grin/conf/grin_pubpool.json`, re-run 4) Setup nginx.
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
- **Public page set consolidated 2026-06 — 8 pages in `public_html/`:** `index.html` (dashboard +
  connect + info), `miners-stats.html`, `payment-history.html`, `account-settings.html`,
  `fortune-board.html`, `donate.html` (last two = incentives), `login.html` (admin door, public zone),
  and `page.html` (generic renderer for operator-authored pages via `/page.html?p=<key>`; footer
  links + the SITEMAP authored-pages come from `poolSettings.listEnabledPages()`). **Deleted:**
  `connect.html` + `pool-info.html` (merged into the dashboard `#connect` / `#info` anchors),
  `home-classic.html` (orphan dup of index), `grin_mining_testnet_instruction.html` (testnet on a
  mainnet-only product — testnet lives in the solo script), `system-health.html` +
  `admin-dashboard.html` (the gated `/admin/` panel is the sole admin surface; login → `/admin/`).
  When removing/renaming a public page, fix the backend `SITEMAP_PATHS` in `index.js` and every
  `nav-link` href across the other pages. **`sitemap.xml` / `robots.txt` / `manifest.json` are
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
    to active rows with a `stratum_url`, falling back to the single-stratum callout when none. The pill
    `status` (`online`/`stale`/`offline`/`unknown`) is derived from the in-memory satellite heartbeat
    with a recent-shares fallback (`unknown` = no signal yet, shown neutral — never a false "down").
    To make this truthful for a *quiet* region, the satellite `lib/share-relay.js` POSTs an **empty
    idle heartbeat** (`{region, shares:[]}`) to `/api/shares` every `HEARTBEAT_MS` (60 s) when there
    are no shares to flush, so a healthy-but-empty region reads `online` instead of `offline`.
    `db.js seedDefaultRegions()` seeds amer/euro/asie (amer/euro/asie.grinium.com) **only when the
    table is empty** — cosmetic defaults the operator edits in admin → Regions.
  - **Service status strip** — public `GET /api/pool/status` (rate-limited, 15s cache) returns
    coarse health only: `pool.ok`, `node {reachable,synced,peers,height}`, `wallet {reachable}`.
    **Never** exposes wallet balance/addresses (those stay on admin-only `/api/admin/health/*`).
  - **Branding/header** — `js/branding.js enhanceHeader()` runs site-wide (every page that has a
    `.brand`): swaps the `.dot` for the swinging atomic-green logo (`#b8e600→#7a9700`, CSS keyframe
    `brandSwing`, ~80° pendulum pivoting near the top, respects `prefers-reduced-motion`), adds the
    slogan (`pool_tagline`, default "Mine Grin, anywhere") under the wordmark, and injects a
    `🎁 Rewards` nav link → `fortune-board.html` when incentives are enabled. Footer sub-brand is
    "GRINIUM — Grin Mining Pool" (was "Uranium Element…").

### Multi-region — hub-and-spoke (design: `docs/generated/script07_design.md` §3–4)

Script 07 supports three deployment modes, selected at launch (mode may be passed as `$1` = `singlebox|hub|satellite` for non-interactive launches):
- **singlebox** — Hub + co-located Satellite on one server (original behaviour; the existing `pool_singlebox_loop`).
- **hub** — Central Hub only (the brain): Central API (sole DB writer), SQLite/WAL + schema + retention job, web dashboard + admin, Grin wallet (Tor payouts), nginx. Sourced from `lib/07_lib_hub.sh`; reuses the shared `pool_*` setup functions.
- **satellite** — Regional node + stratum proxy + share relay; **no** web/admin/DB/wallet. Sourced from `lib/07_lib_satellite.sh`. Config: `/opt/grin/conf/grin_satellite.json`.

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
