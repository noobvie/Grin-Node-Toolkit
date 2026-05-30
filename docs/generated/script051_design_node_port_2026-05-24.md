# Script 051 — PHP → Node.js Wallet Port

**Date:** 2026-05-24
**Source:** `noobvie/GrinSuite@origin/main:web/03_web_wallet/` (Node + Express)
**Target:** `Grin-Node-Toolkit/web/051_wallet/` + `scripts/051_grin_private_web_wallet.sh`

## Goal

Lift-and-shift the GrinSuite Windows Node.js wallet (server.js + client/) onto
the toolkit's Linux VPS deploy path managed by Script 051. Replace the existing
PHP stack (proxy.php / login.php / qr.php) entirely; keep the public-facing
model (nginx + Basic Auth + SSL) intact.

## Architectural decisions

These shape every other change. Documented here so the user can flip any of them
before the code is reviewed.

### D1. Multi-wallet, single Node instance, both networks

The GrinSuite Node wallet is registry-driven (`wallets_info.json`) and serves
mainnet + testnet wallets simultaneously from one process. We **keep that**:

- One systemd unit: `grin-web-wallet.service`
- One Node process bound to `127.0.0.1:7420`
- Wallets registered in `/opt/grin/webwallet/wallets_info.json`
- One nginx vhost, one Basic Auth file, one SSL cert, one domain

**Replaces** the previous 051 model of two separate deploys (`web-wallet-main` +
`web-wallet-test`) with two listener ports and two everything. Network choice
moves from the bash entry menu to the in-app wallet wizard.

### D2. Node owns grin-wallet lifecycle — bash does not

The Node server spawns/kills `grin-wallet listen` and `grin-wallet owner_api`
child processes per-wallet (passphrase piped via stdin, never on argv). Bash
must **not** also run grin-wallet in tmux — that would race on ports.

The bash's old "Step 1: install + init + start listener" becomes:
- Install the **grin-wallet binary** to a known path (`/opt/grin/webwallet/grin-wallet`)
- That's it. Wallet init / recover / start / stop is done by the user via the web UI.

### D3. Setup tab — kept, but trimmed to what makes sense on Linux

The Node wallet's `Setup` tab originally included a Windows wizard for
NSSM/node-services. On Linux, Script 01 owns node lifecycle. The Setup tab is
trimmed to:

| Subsection | Status |
|---|---|
| Wallet binary install/upgrade | **Keep** — adapt to `linux-x86_64` GitHub asset |
| Tor status (Tor running?) | **Keep** — adapt to `systemctl is-active tor@default` |
| Tor install | **Drop** — `apt-get install tor` is one bash line in toolkit |
| NSSM install | **Drop** — Linux has systemd |
| Node service install | **Drop** — Script 01 owns this |
| Legacy task migration | **Drop** — Windows-only concept |
| Wallet wizard (new / recover / import) | **Keep** — adapt default paths |
| Public node ping wizard | **Keep** — adapt local fallback paths |

### D4. Reverse-proxy auth — two layers

```
Browser ──HTTPS──> nginx (Basic Auth) ──HTTP──> 127.0.0.1:7420 (Node)
                                                       │
                                                       ↓ per-wallet passphrase
                                                  grin-wallet owner_api
```

- Layer 1: nginx Basic Auth (defends entire surface — same as PHP 051)
- Layer 2: per-wallet passphrase (defends wallet session — Node-native)

### D5. Host / Origin guard — environment-configurable

The Node server's CSRF defense rejects any `Host` not in `127.0.0.1:7420 /
localhost:7420 / [::1]:7420`. Behind nginx this would reject everything.

Solution: read `WW_PUBLIC_HOST` and `WW_PUBLIC_ORIGIN` from the systemd
environment file. Bash writes them when the domain is configured. Adds the
public host to `ALLOWED_HOSTS` and the public https origin to `ALLOWED_ORIGINS`
at startup.

The localhost entries stay too, so direct `ssh -L 7420:127.0.0.1:7420` tunnels
still work for debugging.

### D6. Run as root — same as rest of toolkit

The Node server runs under `root:root` in systemd. Wallet dirs are
`root:root 700`, secret files `root:root 600`. Matches the rest of the toolkit
(no extra `grin` user introduced for this single change).

If we ever add a `grin` system user, all toolkit scripts get updated together
— not a one-off here.

### D7. Bind 127.0.0.1 only — nginx is the public surface

The Node listener stays `127.0.0.1:7420` (no public binding). Public traffic
must go through nginx (which adds rate limits, Basic Auth, SSL, headers).
This matches GrinSuite's existing model and our PHP 051 model.

## What changes — file-by-file

### Add
- `web/051_wallet/server.js` — ported from GrinSuite (Linux-only, NSSM stripped)
- `web/051_wallet/package.json` — `express ^4.21.2`
- `web/051_wallet/client/{index.html, app.js, style.css, qrcode.min.js, favicon.svg, grin_darkblue_white.svg, grin_red.svg}` — copy from `d:/tmp/grinsuite-wallet/client/`
- `web/051_wallet/README.md` — short note that this is the ported wallet (kept brief)

### Delete (PHP stack)
- `web/051_wallet/public_html/` — entire dir (replaced by `client/`)
- `web/051_wallet/nginx.conf.template` — replaced by bash heredoc
- `web/051_wallet/.api/csrf.php`, `login.php`, `proxy.php`, `qr.php`
- `web/051_wallet/.js/grin-wallet-client.js`, `slate-handler.js`
- `web/051_wallet/css/wallet.css`

### Rewrite — `scripts/051_grin_private_web_wallet.sh`

Keep the script's outer shape (menu, network refs in titles, log helpers,
SSL/auth/firewall steps) but rewrite the deploy + service sections.

| Old step | New step |
|---|---|
| 1. Install wallet binary | **Install grin-wallet binary** to `/opt/grin/webwallet/grin-wallet` (was per-network — now shared) |
| 2. Install dependencies | **Install nodejs + nginx + certbot + htpasswd + tor** (drop php / php-fpm / php-curl / php-json) |
| 3. Deploy files | **Copy `web/051_wallet/` to `/opt/grin/webwallet/app/`**, run `npm install --omit=dev` |
| (new) 3b | **Write systemd unit** `grin-web-wallet.service` with `WW_PUBLIC_HOST` / `WW_PUBLIC_ORIGIN` env |
| 4. Configure nginx | **Reverse proxy** `/` → `http://127.0.0.1:7420` (no PHP-FPM blocks; keep `auth_basic`) |
| 5. Setup SSL | **Unchanged** — Let's Encrypt or Cloudflare Origin Cert |
| 6. Setup Basic Auth | **Unchanged** — htpasswd |
| 7. Configure firewall | **Unchanged** — ufw / iptables for 80/443 |
| 8. Status & info | **Adapt** — show systemd unit status + Node port + nginx + wallets registered |
| 9. Edit settings | **Adapt** — domain, email, auth user (drop PHP-FPM socket) |

### Drop network-pinned variables

`WW_NETWORK`, `WW_WALLET_API_PORT`, `WW_NET_FLAG`, `WW_NET_LABEL`,
`WW_RATELIMIT_ZONE` per-network — collapse to single-deploy globals.

The `select_network` menu disappears. `wallet_menu` becomes the entry point.
(The XP wallet stays accessible via a dedicated menu item.)

## Routes table — what the ported server.js exposes

These are kept verbatim from GrinSuite except for path adaptation:

**Wallet ops** (per-wallet, via Owner API ECDH session):
- `GET  /api/wallets`
- `POST /api/wallet/:name/connect` — auth, opens ECDH session
- `POST /api/wallet/:name/disconnect`
- `GET  /api/wallet/:name/session`
- `POST /api/wallet/:name/{start,stop}-listener`
- `POST /api/wallet/:name/{start,stop}-owner`
- `POST /api/wallet/:name/init` — new wallet from seed
- `POST /api/wallet/:name/recover` — recover from BIP-39
- `GET  /api/wallet/:name/status` — balance + address
- `GET  /api/wallet/:name/txs`
- `GET  /api/wallet/:name/locked-outputs`
- `POST /api/wallet/:name/cancel-tx`
- `POST /api/wallet/:name/fee` — estimate
- `POST /api/wallet/:name/send` — slatepack or tor (mainnet `grin1…` / testnet `tgrin1…`)
- `POST /api/wallet/:name/receive`
- `POST /api/wallet/:name/finalize`
- `GET  /api/wallet/:name/payment-proof/:tx_slate_id`
- `POST /api/wallet/:name/verify-proof`
- `POST /api/wallet/:name/invoice`
- `POST /api/wallet/:name/pay-invoice`
- `POST /api/wallet/:name/scan`
- `POST /api/wallet/:name/unpack` — slatepack decode (read-only)
- `GET  /api/wallet/:name/outputs`
- `GET|POST /api/wallet/:name/accounts`
- `POST /api/wallet/:name/show-seed` — passphrase-gated, rate-limited
- `POST /api/wallet/:name/post-tx` — re-broadcast
- `POST /api/wallet/:name/export` — encrypted `.gws` backup
- `POST /api/wallet/import`
- `DELETE /api/wallet/:name` — delete (?files=1 to also rm wallet dir)
- `GET  /api/wallet/:name/address-book`
- `POST /api/wallet/:name/address-book`
- `DELETE /api/wallet/:name/address-book/:address`

**Setup** (trimmed):
- `GET  /api/setup/binary-status`
- `POST /api/setup/install-binary` — SSE progress
- `GET  /api/setup/default-dir?network=&name=` — proposes `/opt/grin/webwallet/wallet_<net>_<name>`
- `POST /api/setup/check-dir`
- `POST /api/setup/rename-dir`
- `GET  /api/setup/nodes?network=` — SSE ping of public + local nodes
- `POST /api/setup/write-config` — register wallet in `wallets_info.json`
- `GET  /api/setup/tor-status` — `systemctl is-active tor`, port 9050

**Node + meta**:
- `GET  /api/node/status`
- `GET  /api/node/peers`
- `GET  /api/node/sync-detail`
- `GET  /api/node/ping?url=`
- `GET  /api/node/local/:network`
- `POST /api/wallet/node` — change wallet's `check_node_api_http_addr`
- `GET  /api/price` — GRIN/USD/BTC (CoinGecko, 60s cache)
- `GET  /api/portfolio` — aggregated mainnet wallet totals

**Removed** (Windows-only):
- `POST /api/setup/install-tor`, `start-tor`, `stop-tor`, `uninstall-tor-service` — Linux uses `systemctl tor`
- `POST /api/setup/install-nssm` — N/A on Linux
- `POST /api/setup/install-node-service`, `start-`, `stop-`, `set-mode`, `uninstall-`, `node-service-status` — Script 01 owns this
- `GET  /api/setup/legacy-node-tasks` — Windows Task Scheduler concept

## Deploy layout (target VPS)

```
/opt/grin/webwallet/
  grin-wallet                        single binary, shared by all wallets
  wallets_info.json                  registry (root:root 600)
  config.env                         systemd env file with WW_PUBLIC_HOST etc
  app/
    server.js                        Node express server
    package.json
    node_modules/                    npm install --omit=dev
    client/                          static UI
  wallet_mainnet_<name>/             per-wallet dirs (root:root 700)
    grin-wallet.toml
    .owner_api_secret
    .foreign_api_secret
    .wallet_address                  cached slatepack address
    .address_book.json               sidecar address book
    wallet_data/
      wallet.seed
  wallet_testnet_<name>/

/etc/systemd/system/grin-web-wallet.service
/etc/nginx/sites-available/grin-web-wallet
/etc/nginx/sites-enabled/grin-web-wallet
/etc/nginx/grin-web-wallet.htpasswd
/etc/nginx/conf.d/grin-web-wallet-ratelimit.conf
```

## Per-wallet port allocation

The Node server picks ports automatically when a wallet is registered. Bases:

| Network | Foreign | Owner |
|---|---|---|
| mainnet | 3415, 3416, … | 3420, 3421, … |
| testnet | 13415, 13416, … | 13420, 13421, … |

All bound to `127.0.0.1` only (grin-wallet defaults). Never exposed in firewall.

## Security carry-overs from GrinSuite

These properties are inherited from the upstream Node code and **must not be
weakened** during port:

- **Passphrase never on argv** — piped to grin-wallet via stdin, then closed.
  Listed in `ps` would expose to any local user.
- **Owner API ECDH** for every call — wallet passphrase / seed never traverses
  unencrypted HTTP, even to localhost.
- **Network mismatch hard-block** on Tor send — sending mainnet GRIN to a
  `tgrin1…` address (or vice versa) returns 400 `NETWORK_MISMATCH` instead of
  burning funds.
- **Show-seed rate-limited** — reuses the connect limiter (5/min per ip+wallet).
- **`.gws` backup format** — AES-256-GCM, 200k PBKDF2 iterations, 16-byte salt,
  12-byte IV. Refuses to overwrite an existing wallet on import.
- **Slatepack validation** — 16 KB cap, must contain BEGIN/END markers.
- **`nodeUrl` regex** — single-line http(s) with safe chars only (prevents TOML
  injection via `check_node_api_http_addr = "..."`).
- **Path traversal guard** on `.gws` import — refuses `..` or absolute paths in
  the backup manifest.

New for the Linux port:
- **systemd** drops privileges via `User=root` (no change yet — see D6) but uses
  `ProtectSystem=full`, `ProtectHome=true`, `PrivateTmp=true`,
  `NoNewPrivileges=true`, and `ReadWritePaths=/opt/grin/webwallet` to limit
  blast radius if Node is compromised.
- **nginx Basic Auth** in front (carried from PHP 051).
- **nginx rate limit** retained for `/api/wallet/*/send` (3r/m) and other
  `/api/*` (10r/m), `/` (20r/m).
- **`proxy_set_header Host $http_host`** so Node's host guard sees the
  configured public hostname (matching `WW_PUBLIC_HOST` env). Origin passes
  through untouched.

## Open questions / follow-ups (post-merge)

- **fail2ban** — current 051 README mentions it as TODO. Same applies post-port:
  watch nginx 401s, ban after 5 fails in 10 min.
- **expose_php = Off** — N/A now, no PHP.
- **CSP nonce** — current UI is `script-src 'self'` (no inline). Re-verify after
  copy; the GrinSuite UI may have a small inline theme-bootstrap script
  (`<script>(function(){var t=localStorage…})();</script>` in `<head>`). If so,
  either move it to a separate `.js` file or add `script-src 'self' 'unsafe-inline'`
  in CSP (less safe). Decision deferred until after copy.
- **Backup/restore in admin centre** — Script 08 admin centre may want to
  surface `/opt/grin/webwallet/` for backups. Out of scope for this port.

## Testing checklist (when the user runs it)

Order matters — earlier steps are prerequisites for later.

1. `bash -n scripts/051_grin_private_web_wallet.sh` — no syntax errors
2. `node -e "require('./web/051_wallet/server.js')"` (smoke parse — should fail
   gracefully on missing wallets_info.json, not crash on syntax)
3. On a VPS: run script 051 → menu 1 (install grin-wallet binary)
4. → menu 2 (install nodejs + nginx + certbot + tor)
5. → menu 3 (deploy files + write systemd unit)
6. → menu 4 (configure nginx — domain prompt)
7. → menu 5 (SSL)
8. → menu 6 (Basic Auth)
9. → menu 7 (firewall)
10. Browser → `https://<domain>` → Basic Auth prompt → wallet UI
11. **Setup tab** → check binary status (should be installed), check Tor status
12. **Add Wallet wizard** → testnet → create new → verify seed display
13. **Send / Receive** via slatepack between two testnet wallets on the same node
14. **Tor send** between two testnet wallets (one running on same VPS, one local
    behind Tor) — verify network mismatch block by feeding it a `grin1…` address
15. **Show seed** — wrong passphrase 5× → 429 rate limit kicks in
16. **Export `.gws`** → wipe wallet dir → **Import `.gws`** → verify balance
17. **systemctl restart grin-web-wallet** → UI reloads cleanly, in-memory
    passphrases lost (expected — re-unlock required per wallet)
