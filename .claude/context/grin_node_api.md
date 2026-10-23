# Grin node + wallet API, secrets, ports

> Split out of `.claude/CLAUDE.md` (which points here). Read on demand — keep the
> always-loaded CLAUDE.md lean; add new detail HERE, not there.

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
`8080` (testnet `8090`; localhost-bound, fronted by the nginx HTTPS vhost — that vhost is the
only way in, and `/api/admin/` is IP-allowlisted there). ⚠ Regional gateways do **not** reach
it: they forward raw **stratum** over WireGuard to a per-region internal port on the central box
(`3391+` mainnet / `13391+` testnet, miner IP in PROXY-protocol v2) and speak no HTTP to the pool
at all. Solo mining uses the same node stratum `3416`/`13416`.
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
branches on `stdin.is_terminal()` and still reads a piped passphrase. The shared pin
(`GWI_DEFAULT_TAG`) moved to v5.5.0 on 2026-09-25; Fidelius still pins v5.4.1 on its own.
Stdin feeding is safe on both — see memory
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

