# Grin Node Toolkit — Claude Instructions

## Project Overview
A unified bash toolkit for deploying and managing Grin cryptocurrency nodes and
infrastructure on Linux servers (Debian/Ubuntu, Rocky Linux, AlmaLinux 10+).
Run as root/sudo on a remote VPS — not executed locally on this machine.

## Tech Stack
- **Shell:** Bash (primary language — all scripts must pass `bash -n` syntax check)
- **Web backend:** Node.js/Express + SQLite (script 052, 053, 054, 055)
- **Web server:** Nginx (vhost management, SSL via certbot)
- **Process management:** systemd services + tmux sessions
- **Grin tooling:** grin-wallet binary (Foreign API v2, Owner API v3 ECDH)
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
  07_  Mining services
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

## tmux Sessions — Always Use Bash
When generating `tmux new-session` commands (in cron wrappers, watchdog scripts, or any
code that may run from cron), always prefix the call with `SHELL=/bin/bash`:

```bash
SHELL=/bin/bash tmux new-session -d -s "name" -c "$DIR" "command"
```

**Why:** cron sets `SHELL=/bin/sh` in its environment. A `#!/bin/bash` shebang only sets
the interpreter for the script itself — it does not change the `SHELL` env var inherited
by child processes. If a tmux server starts (or a new session is created) while `SHELL`
is `/bin/sh`, all sessions in that server use `sh`, not `bash`. The inline assignment
`SHELL=/bin/bash tmux ...` passes bash to the tmux server regardless of how it was
started. Using `export SHELL=/bin/bash` at the top of a wrapper is not sufficient when
the tmux server was already started by a different process.

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

## Nginx Configuration — Naming & Conflict Prevention

**Critical:** Nginx config files from multiple scripts can conflict if they define
the same zones, upstreams, or directives in the same context (http/server/location).
Nginx loads ALL files in `/etc/nginx/conf.d/*.conf` into the http context — if two
scripts define the same `limit_req_zone` with different names or rates, nginx errors.

### Naming Convention
- **Shared zones** (used by multiple scripts): Defined ONCE by the authoritative script.
  - Example: Script 06 defines `limit_req_zone "grin_api"` in `/etc/nginx/conf.d/grin-rate-limit.conf`
  - Other scripts (04, 07, etc.) must NOT redefine it — they only use it via `limit_req zone=grin_api`
- **Script-specific configs**: Name with script prefix to avoid collisions.
  - Script 04: `/etc/nginx/conf.d/script04-node-api.conf`
  - Script 07: `/etc/nginx/conf.d/script07-pool.conf`
  - Script 052: `/etc/nginx/snippets/script052-drop.conf` (for location blocks)

### Rules
1. **One script owns each shared resource.** If Script 06 defines `grin_api` zone, no other
   script should redefine it. If Script 04 needs it, use it — don't declare it again.
2. **Zones must have unique names across the entire nginx config.** Before adding a new zone,
   grep the entire codebase to ensure no other script uses that name.
3. **Check before writing:** Before creating a conf file, verify:
   ```bash
   grep -r "zone=name_here" scripts/ lib/  # Check if zone exists elsewhere
   grep -r "/etc/nginx/conf.d/your-name.conf" scripts/  # Check if file path is unique
   ```
4. **Test syntax after changes:**
   ```bash
   nginx -t  # Always run before systemctl reload
   ```

### Example: Avoiding Duplicates (Script 04 ↔ Script 06)
**BAD (causes nginx error):**
- Script 04 writes: `limit_req_zone $binary_remote_addr zone=grin_api:10m rate=10r/s;` to `/etc/nginx/nginx.conf`
- Script 06 writes: `limit_req_zone $binary_remote_addr zone=grin_api:10m rate=30r/m;` to `/etc/nginx/conf.d/grin-rate-limit.conf`
- Result: nginx loads both → duplicate zone definition → ERROR

**GOOD (single authoritative source):**
- Script 06 defines `grin_api` zone in `/etc/nginx/conf.d/grin-rate-limit.conf`
- Script 04 only uses `limit_req zone=grin_api burst=10 nodelay;` in its location blocks
- No redefinition, no conflict

## Do Not
- Never run the toolkit scripts locally — they assume a Linux VPS with root access
- Never hardcode wallet API secrets or passwords in scripts
- Never skip the `bash -n` check before committing a shell script change
- Never use `--floonet` flag — the correct testnet flag is `--testnet`
- Never mix mainnet and testnet ports or directories
- Don't add `#!/bin/bash` to lib files — they are sourced, not executed
- **Never redefine nginx zones/upstreams across multiple scripts** — define once, use everywhere
