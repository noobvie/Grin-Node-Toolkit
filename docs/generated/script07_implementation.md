# Script 07 — Public Mining Pool (Implementation)

> **Covers code as of:** 2026-09-07, except §8.7 and the §4/§8.2/§11 rows that point at it (2026-09-23, the uncommitted hub-move + latency working tree) and §10.6 (2026-09-24, the uncommitted §18 Parts 1–6 working tree) and §10.7 (2026-09-24, the uncommitted explorer-setting working tree) and §10.8 plus the §2 auto-payout / chain-watch / Tor-send rows, D10 and the §3 scheduler rows (2026-09-25, the uncommitted Tor-payout-hardening working tree) · **Last verified:** 2026-09-25, PARTIAL — **§10.8 *Independent review* only, by the Part 8 review session**: its two fixes read in `lib/withdrawal-scheduler.js` after the edit; the two bugs' cases (R1–R4) seen failing before the fix, and every new case seen failing with its guard removed in a scratch copy; `npm test` re-run, exit 0. Same day, PARTIAL — **§10.8, the three §2 rows, D10 and the two §3 rows only, by the Tor-payout-hardening docs-fold session**: the constants, alert types, event-note prefixes, journal strings, `chain_state` classes, the `repost -i <id> -f` argv, the `method = 'tor'` proof-backfill filter, the settings key/validator/`applyToConfig`, the two `lib/db.js` columns, the `index.js` health fold and admin-row strip, the `health.html` Critical badge and the `payments.html` `CHAIN` map were read in the working tree that session, and `withdrawal_retry_delays` was grepped absent from every admin page; `npm test` re-run, exit 0, with the five touched suites at the counts quoted in §10.8. **Taken from the build sessions' reports, not re-checked:** the grin-wallet source citations (v5.4.1 / v5.5.0), the revert-proofs and mutation counts, and deviations (a)–(f). 2026-09-24, PARTIAL — **§10.7 only, by the explorer-setting docs-fold session**: written against the code as read that session (`lib/explorers.js` in full, the `index.js` resolve helper + the three publishing routes + `/api/admin/blocks`, `lib/pool-settings.js` default/validator/`buildPublicConfig`, the `window.Explorer` block and primer in `branding.js` and `admin-shell.js`, the `blocks.html` primer, the Branding select + its testnet script, and every `Explorer.link` call site grepped); `npm test` re-run, exit 0, `test-explorers.js` 198/198. The Part 3 relink finding and the audit-row correction are taken from the code comments and the plan, not from a review report. Same day, PARTIAL — **§10.6 *Part 6* only, by the §18 Part 6 review session**: its fix read in `index.js` and the page, its two new checks seen failing before the edit and passing after, `npm test` re-run (1345/1345, 20 suites); the same session re-ran `npm test` before any edit and found every §10.6 Part 1–5 total and per-suite count exact (1343), but did **not** re-verify the rest of those Part notes' prose. Same day, PARTIAL — **§10.6 *Part 5* only, by the §18 Part 5 build session**: written against the code as edited that session, with `npm test` re-run (1343/1343, 20 suites) and a one-shot 390 px headless-Edge probe of `account-settings.html` in both themes (0 overflow, four fixtures). Same day, PARTIAL — **§10.6 *Part 4* only, by the §18 Part 4 build session**: written against the code as edited that session, with `npm test` re-run (1331/1331, 20 suites) and a one-shot 390 px + 1280 px headless-Edge probe of `donate.html` in both themes (0 overflow, five fixtures). Same day, PARTIAL — **§10.6 *Part 3* only, by the §18 Part 3 build session**: written against the code as edited that session, with `npm test` re-run (1310/1310, 20 suites, after the same-day switch to a plain-`src` preview), the cookie attributes behind that switch read in `index.js`, and a one-shot jsdom render of `donors.html` (26/26). Same day, PARTIAL — **§10.6 *Part 2* only, by the §18 Part 2 build session**: written against the code as edited that session, with `npm test` re-run (1298/1298, 20 suites), the multer size boundary measured with a one-shot fake-stream run, and the `/uploads/` nginx/rsync/backup claim grepped in the pool script. Same day, PARTIAL — **§10.6 *Part 1* only, by the §18 Part 1 build session**: written against the code as edited that session, with `npm test` re-run (1145/1145, 19 suites). 2026-09-23, PARTIAL — **§8.7 *Part 9 review fixes* only, by the review session**: each fix read in the code it wrote and its harness result as run that session. Also 2026-09-23, PARTIAL — **§8.7 only, by the doc-fold session**: its file list, menu keys, config keys, endpoint shapes and on-box paths grepped/read in the code (`07_lib_pool_backup.sh` menu dispatch, the `pmg_*` function list and manifest name in `07_lib_pool_migrate.sh`, the `GW_*` paths + `maxconn` in `07_lib_gateway.sh`, the latency keys + page CSP in the pool script, the suggest route in full in `index.js`, `lib/connect-suggest.js` constants, the three new suites in `package.json`) and `npm test` re-run, 1133/1133 across 19 suites; the step order of Migrate OUT/IN, the manifest's field list and the harness results are **taken from the build sessions' reports, not re-checked**. Before that: 2026-09-07 — §§1–8 and §11 re-derived from
> `scripts/07_grin_mining_public_pool.sh`, `scripts/lib/07_lib_{gateway,gwctl,hub,pool_backup,pool_wallet}.sh`
> and `web/07_mining_pool_public/back-end-pool/`. §§9–10 are as-written add-on notes, not re-verified — except §10.4, written against the
> code it describes on 2026-09-22 (Part 1 backend and Part 2 account page, both re-read after the
> edits) and 2026-09-23 (Part 3: every surface in its table re-read after the edit, and the CMS
> seed-once claim read in `lib/db.js`) and again by the Part 4 review (2026-09-23: §10.4's capture/verify, cost, migration and test paragraphs re-read against `lib/owner-proof.js`, `index.js` and `test-owner-gate.js`; four statements corrected in place, KDF counts measured), backed by the suite counts quoted in it. And §10.5 (payout-rails fix), written 2026-09-23 against the uncommitted diff of its three code parts — `lib/wallet.js`, `lib/wallet-tor.js` in full, `lib/socks5.js` header, `lib/config.js`, the `index.js` tor-check/pre-flight hunks, `account-settings.html` — with `npm test` re-run that session (945/945, 16 suites) and the `proxy_read_timeout` values read in `07_grin_mining_public_pool.sh`. **Taken from the build sessions' own reports, not re-checked:** the revert-proofs, the P-04 word counts, the headless-Chrome probe, and the audit of the other ten Owner calls against `owner_rpc.rs`. §10.5 then re-read by the Part 5 review (2026-09-23, PARTIAL — Parts 1–3 bullets against `lib/wallet.js`, `lib/wallet-tor.js`, `lib/socks5.js` (diffed against 06d), the `index.js` route + gate and `account-settings.html`; the ten Owner-call orders and `create_slatepack_message`/`tx_lock_outputs` re-checked against v5.4.1 `owner_rpc.rs` upstream; one claim corrected — a misspelt named key is rejected, not ignored; Part 5 fixes written against their own code, suite 960/960). The word counts and headless probe are still taken from Part 3's report.
> §1b re-verified 2026-09-21: all 49 `API_DOC_META` rows read against their handlers (static, no VPS).
> **Product code last changed:** 2026-09-25 (Tor payout hardening, Part 8 review fixes — the per-row freeze re-check and `_dropStepwiseSlate` in `checkTorAndSend`, `lib/withdrawal-scheduler.js`; `test-payout-guard.js` 220 → 233; §10.8 *Independent review*; **uncommitted, not VPS-tested**). Same day (Tor payout hardening F1–F5 + the exit-0 slatepack fallback — `lib/withdrawal-scheduler.js`, `lib/wallet.js`, `lib/wallet-tor.js`, `lib/db.js`, `lib/pool-settings.js`, `lib/config.js`, `index.js`, `admin-panel/health.html` / `payments.html` / `settings-payout.html`, five test suites; §10.8; **uncommitted, not VPS-tested**). 2026-09-24 (operator-selectable mainnet explorer — NEW `lib/explorers.js`, `branding.explorer_mainnet` in `lib/pool-settings.js`, `explorer` published on three routes in `index.js`, `window.Explorer` + relink in `branding.js`/`admin-shell.js`, the `blocks.html` primer, the Branding select, NEW `test-explorers.js`; §10.7; **uncommitted, not VPS-tested**). Same day (hub move, review P1 — Migrate OUT removes the weekly VACUUM cron and refuses while a vacuum runs, §8.7 *Part 9 review fixes*). Same day (donations v2, design §18 Part 6 review fix — `index.js` `requireBothProofs` refusal code `match` → `wrong_kind`, `account-settings.html` `DP_REASONS` key; suite 1343 → 1345; **uncommitted, not VPS-tested** — §10.6 *Part 6*). Same day (donations v2, design §18 Part 5 — account page: `public_html/account-settings.html` P-05 donation row from `donation`, P-03 per-rig badge, NEW P-09 Donor profile panel; `index.js` drops the v1 account aliases `donation_percent` / `donor_name` / `donor_name_state` + api-docs row; suite 1331 → 1343; **uncommitted, not VPS-tested** — §10.6 *Part 5*). Same day (donations v2, design §18 Part 4 — public wall: `lib/donor-ledger.js donorWall()` card `banner` under the Top-N slot rule + `ranking.banner_slots`, `current_percent` dropped; `bannerSlots` exported from `lib/donor-profiles.js`; `index.js` donors route comment + `API_DOC_META` row v3; `public_html/donate.html` D-01 rewrite, new D-01b, D-03 Top-N spotlight + §18.3 card copy; suite 1310 → 1331; **uncommitted, not VPS-tested** — §10.6 *Part 4*). Same day (donations v2, design §18 Part 3 — admin review queue: `index.js` donor admin routes rewritten (queue, image, approve/reject/remove/block/unblock, summary + dashboard pending count; censor/uncensor + the settings-save rescan removed; wall + account names from approved profiles only), `lib/donor-names.js` reduced to words + flags + settings, `lib/donor-profiles.js` admin reads, `lib/donor-ledger.js` names via `publicProfiles`, `donor_censored_display` removed from `lib/pool-settings.js`, `admin-panel/donors.html` rewritten, `admin-shell.js` badge + `AdminTable.onRender`, `admin-panel/index.html` tile, banner previews from a plain same-origin `src` (admin CSP unchanged — a comment only in `07_grin_mining_public_pool.sh`); suite 1298 → 1310; **uncommitted, not VPS-tested** — §10.6 *Part 3*). Same day (donations v2, design §18 Part 2 — donor-profile backend: `donor_requests` + `donor_blocks` in `lib/db.js`, NEW `lib/donor-profiles.js` (name rules, banner sniff + header dims, the request state machine, approved files under `uploads/donors/`, `profileFor` / `publicProfiles`), `leagueRank()` in `lib/donor-ledger.js`, `SNIFFERS` exported from `lib/asset-manager.js`, `donor_banner_slots` in `lib/pool-settings.js` + `lib/donor-names.js`, `index.js` `requireBothProofs` purpose wording + three `/api/account/:addr/donor-profile` routes + account `donor_profile`; NEW `scripts/test-donor-profiles.js`, suite 1145 → 1298; **uncommitted, not VPS-tested** — §10.6 *Part 2*). Same day (donations v2, design §18 Part 1 — the donation is per SHARE: `lib/rewards.js` `donateMap`, `lib/incentives.js` `applyToDistribution(…, donateMap)`, stored-% machinery removed from `incentives.js` / `stratum-server.js` / `miners.js` / `stratum-protocol.js` (`donor_label`), NEW `liveDonations()` in `lib/donor-ledger.js`, additive `donation` / `donate_percent` / `rigs_donating` / `pct_min` / `pct_max` fields on four routes in `index.js`; suite 1134 → 1145; **uncommitted, not VPS-tested** — §10.6). 2026-09-23 (Part 9 review fixes C1–C6 in `07_lib_pool_migrate.sh` + `07_lib_pool_backup.sh`, §8.7 *Part 9 review fixes*). Same day (hub move + connect-page latency, §8.7: NEW `07_lib_pool_migrate.sh` (`B → 6/7`), shared freeze/archive/restore cores in `07_lib_pool_backup.sh`, gateway re-resolve timer + `6) Latency probe` in `07_lib_gateway.sh`, hub `/ping` + CSP + pairing warning in the pool script; backend seeds v3 + local-region stamp, NEW `lib/region-rtt.js` / `lib/connect-suggest.js` / `lib/latency-probe.js`, `/api/pool/connect/suggest`, `hub_rtt_ms`/`is_hub`, `connection.latency`; connect-page measurement in `reactor-dashboard.js`; suite 960 → 1133, 16 → 19 suites; **uncommitted, not VPS-tested**). Same day (payout-rails fix, §10.5: `create_slatepack_message` named params in `lib/wallet.js`; Tor probe ported from 06d — `lib/wallet-tor.js`, new `lib/socks5.js`, `lib/config.js` 8 s default, `index.js` `?fresh=1`; P-04 slimmed in `account-settings.html`; new `scripts/test-payout-rails.js`, suite 881 → 945; then the Part 5 review's three fixes — an absolute reply deadline and proxy-protocol errors → null in `lib/wallet-tor.js`, a `res.destroyed` guard in the `index.js` pre-flight gate — suite 945 → 960; **not VPS-tested**). Same day (ownership-proof SET, design §17 Part 4 review — three fixes: `migrateProofSet` now runs before `stratumServer.start()`, `_captureProof` re-locates a racing duplicate by its digest instead of evicting a second proof, a returning evicted anchor restarts `first_seen_at`; plus the `proof_too_recent` text; `test-owner-gate.js` 36 → 42, suite 875 → 881 — §10.4 "Part 4"). Same day (design §17 Part 3 — copy and comments only: `public_html/index.html` setup-guide PIN line, the Terms/Privacy/FAQ defaults in `lib/pool-settings.js`, `index.js` (`anchor_not_accepted_here` text, one `API_DOC_META` row, one comment), `lib/stratum-server.js` / `lib/owner-proof.js` / `lib/db.js` comments; suite unchanged at 875/875 — §10.4 "Part 3"). 2026-09-22 (ownership-proof SET, design §17 Part 2 — account page: `public_html/account-settings.html` only — `proofHintText()` renders `a.proofs` as counts + last-added instead of two booleans, the "Evidence changed" banner and the `evidence` argument deleted, `renderPasswordProof(pp, proofs)` warns only past `proofs.max` ("Too many passwords") with several passwords inside the cap now an OK line, `PASS_STATE_TEXT.ok` reworded, the `Accepted:` line and three fold paragraphs restated for a set of ten, DEMO dataset reshaped; suite unchanged at 875/875 — §10.4 "Part 2". Same day, Part 1 — backend: `miner_proofs` table + `miner_accounts.proof_salt`, per-address scrypt salt, set capture/verify with LRU eviction and a flagged-not-deleted anchor, `migrateProofSet()` replacing `migrateOwnerProofHashes`+`backfillProofAnchors`, `proofs` on the account and admin miner views, `test-owner-gate.js` 19 → 36 and `test-public-leakage.js` 77 → 86 — §10.4. 2026-09-21 (donor names, design §16 Part 5 — the independent review: two fixes in `lib/donor-names.js` (rescan parses the list once per walk; a separators-only label is no label), `test-donor-names.js` 148 → 156, design §16.12 written — §10.3 "Part 5". Same day, Part 4: `/api/pool/donors` v2 — league/past/totals/ranking via `lib/donor-ledger.js donorWall()`, `donate.html` D-03 league + past strip + ranking sentence + not-verified line, D-01 `yourbrandname-donate10`, api-docs row, `test-donor-league.js` 68/68, leakage §9 — §10.3 "Part 4". Same day, Part 3: admin → Donors page, `GET /api/admin/donors` + `/summary`, `POST …/censor|uncensor` audited, rescan on list/pool-name change, dashboard `new_donor_names_7d` + nav badge, `allow_miner_donations`/`donation_address` moved off `settings-incentives.html`, `parseDonateToken` export, `check-syntax.js` type-sniff fix — §10.3 "Part 3". Same day, Part 2: six `donor_*` columns, `lib/donor-names.js` + `lib/donor-ledger.js`, six `incentives` settings keys, capture on the from-zero set only, `/api/account/:addr` `donor_name` + state, account-page row — §10.3 "Part 2". Same day, Part 1: worker part case-folded, label cap 25 → 32, raw 40 → 48, `donor_label` — §10.3 "Part 1". Same day: api-docs audit: 9 meta rows corrected, the drift-check
> regex line-anchored, and `GET /api/account/:addr/shares` un-broken — it had answered `{}` since it
> was written because `getSharesForMiner` was `async` and never awaited. Same day: P-02b lamps show workers; P-03 prints the share COUNT, not the summed difficulty; P-04 24H trace gap-filled with zeros — §7 row 4, §9. Same day: account `is_online` per rig, not per address; donor-wall totals over every donor and `active_donors` from live tags — §10.3. 2026-09-20: share credit unit + one shared `MinerManager` — first live-miner test found every hashrate at 0.00 G/s and MINERS ONLINE 0; §7 rows 3 and 5. Earlier the same day: pairing string carries the public port; gateway Status boot line, design §13.12s) — `scripts/07_grin_mining_*.sh`, `scripts/lib/07_lib_*.sh`, `web/07_mining_pool_public/`

Deployment layout, build/wiring status, database runbook, pre-launch checklist, multi-region
(Model C) as-built, and troubleshooting for the public pool. Design lives in
[`script07_design.md`](script07_design.md); security in
[`script07_security_audit.md`](script07_security_audit.md).

> **Roles:** a box is either the **brain** (`singlebox` — the pool, serving its own miners — or a
> mining-less `hub`) or a **regional gateway** (a thin HAProxy + WireGuard stratum forwarder with
> no node, no wallet, no DB, no Node.js). The old **satellite/relay** role — a full node + share
> relay per region — was deleted from the code on 2026-06-22 (`f2ebade`). Nothing runs it any more;
> it survives only as a *legacy-footprint detector* so `Z) Cleanup` can still remove one (§1).

---

## 1. Deployment layout

**Repo:**
```
scripts/07_grin_mining_hub_services.sh    mining-type selector (solo internet/LAN · pool mainnet/testnet)
scripts/07_grin_mining_public_pool.sh     mode selector → singlebox | hub | gateway | cleanup
scripts/lib/07_lib_hub.sh                 Central Hub menu (brain, reuses the parent's pool_* steps)
scripts/lib/07_lib_gateway.sh             Regional GATEWAY install (haproxy + wireguard only)
scripts/lib/07_lib_gwctl.sh               installs /usr/local/bin/grin-gateway-ctl (sole WG mutation path)
scripts/lib/07_lib_pool_wallet.sh         pw_*: combined Owner+Foreign listener, autostart, watchdog
scripts/lib/07_lib_pool_backup.sh         pbk_*: encrypted backup/restore on the shared gbe_/gbp_ engine
scripts/lib/nginx_shared_helpers.sh       shared nginx rate-limit-zone primitives
web/07_mining_pool_public/
  back-end-pool/        Express backend (index.js, lib/, admin-panel/, public/)
  public_html/          static frontend (nginx serves)
```

**Production (VPS)** — every path is network-keyed; mainnet and testnet never share one:

| | Mainnet | Testnet |
|---|---|---|
| App dir | `/opt/grin/pubpool/mainnet/` | `/opt/grin/pubpool/testnet/` |
| Database | `<app dir>/pool.db` (+ `-wal`/`-shm`) | same |
| Config | `/opt/grin/conf/grin_pubpool.json` | `/opt/grin/conf/grin_pubpool_testnet.json` |
| Wallet dir | `/opt/grin/pubpoolwallet/mainnet/` | `/opt/grin/pubpoolwallet/testnet/` |
| Frontend | `/var/www/grin-pool/` | `/var/www/grin-pool-testnet/` |
| nginx vhost | `/etc/nginx/sites-available/grin-public-pool-mainnet` | `…-testnet` |
| systemd | `grin-pool-manager.service` | `grin-pool-manager-testnet.service` |
| Log | `/opt/grin/logs/grin-pool.log` | `/opt/grin/logs/grin-pool-testnet.log` |

Gateway boxes carry a completely different footprint: `/opt/grin/conf/grin_gateway.json`,
`/opt/grin/gateway/haproxy.cfg`, service `grin-gateway`, tunnel `wg-grinpool`
(`/etc/wireguard/wg-grinpool.conf`), log `/opt/grin/logs/grin-gateway.log`.

> **Legacy paths still recognised:** the pre-2026-06 generic names (`grin_pool.json`, `/opt/grin/pool`,
> `/opt/grin/wallet`, vhost `grin-pool`) and the retired satellite footprint (`grin_satellite.json`,
> `/opt/grin/satellite`, service `grin-satellite`) are detected by `Z) Cleanup` and by the
> mode-collision guard — a legacy satellite still binds :3333, so it blocks a brain or gateway
> install until it is removed. That detector is the ONLY remaining satellite code in the repo.

### systemd unit (per network)
```
[Service]
Type=simple
User=grinpool                       # de-rooted (design §13.9): the backend parses untrusted
WorkingDirectory=/opt/grin/pubpool/<net>          # input on TWO public surfaces (HTTP + raw stratum)
Environment="GRIN_POOL_CONF=<conf>" "NODE_ENV=production" "HOST=127.0.0.1" "PORT=<8080|8090>"
ExecStart=<node> index.js
Restart=on-failure
RestartSec=5
LimitNOFILE=65535
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
RestrictSUIDSGID=yes
ReadWritePaths=-<app dir> -/opt/grin/conf -<wallet dir> -/opt/grin/logs -/etc/wireguard
```
Three traps in that unit, all load-bearing:
- **No `NoNewPrivileges`** — it would break the scoped `sudo grin-gateway-ctl` the admin panel's
  pairing path uses.
- **`/etc/wireguard` in `ReadWritePaths` is not optional.** `ProtectSystem=strict` builds a mount
  namespace that every child inherits *including one that becomes root through setuid sudo*. Without
  the entry, `add-peer`/`remove-peer`/`init-server` fail from the panel while `list`/`status` keep
  working — the page looks healthy right up to the moment you save.
- **`ReadWritePaths` is bound at service start**, so `/etc/wireguard` must exist before the unit
  starts (`pool_ensure_wg_prereqs`); a directory created later is not writable inside the namespace.

The backend handles SIGTERM/SIGINT → stop scheduler → `server.close` → `db.close()` so the SQLite
WAL flushes cleanly on `systemctl stop`. `logrotate` rotates `$POOL_LOG` daily/20 M. The **wallet**
listener has its own `@reboot` autostart + `*/5` watchdog cron (`pw_watchdog_install`, menu `5`);
the pool service itself relies on `Restart=on-failure`, not a cron watchdog.

### nginx
- `/api/*` → `proxy_pass` to the backend (`127.0.0.1:8080`/`8090`); `/*` → static `$POOL_WEB_DIR`.
- `robots.txt`/`sitemap.xml`/`manifest.json` are exact-match `location =` proxies (win over static).
- Rate-limit zones via the shared helper only — **never inline `limit_req_zone`**. Script-specific
  zones use a `script07-` conf prefix (`/etc/nginx/conf.d/script07-<service>.conf`); `/custom/`
  sets `X-Content-Type-Options: nosniff` + a sandbox CSP (see security audit).
- **Three** security-header snippets in `/etc/nginx/snippets/` (`…-headers.conf`,
  `…-page-headers.conf`, `…-admin-headers.conf`) — `/admin/` is static-served, so the vhost *is* the
  panel's CSP, and any block with an `add_header` of its own must re-include one (memory
  `project_pool_nginx_header_snippets`). Cleanup removes them in the same `rm` as the vhost that
  includes them, never before it: an orphaned `include` fails `nginx -t`.
- `nginx -t` before every reload.

### Installer responsibilities
- Node ≥ 24 guard (`node:sqlite`) with NodeSource auto-install (`pool_ensure_node24`); `npm ci` in
  the app dir. **The gateway box deliberately has no Node.js** — `07_lib_gateway.sh` reads/writes
  its JSON with `python3`, and must never shell out to `node`.
- Generate `jwt_secret` **once at install** into the pool config. `validateConfig()` throws at boot
  on a missing/short (<32 char) secret rather than minting one — a fresh secret each restart
  silently logs out every admin and breaks refresh tokens.
- Create/migrate schema via `db.js` (`createSchema()`, additive `ALTER TABLE ADD COLUMN` guards).
- `pool_deroot()` creates the `grinpool` service user, chowns what the app must write, and writes
  the scoped sudoers entry allowing exactly one binary (`grin-gateway-ctl`) as root.
- Write the systemd unit + logrotate + VACUUM/backup cron wrappers; `nginx -t`; certbot for SSL.
- `pool_configure()` prompts: pool name, domain, network, ports, `pool_fee_percent`,
  `pool_fee_address`, `min_withdrawal`, `confirm_depth`, region (default `main`).
- **Gateway install** (`07_lib_gateway.sh`): `haproxy` + `wireguard-tools` + `python3` only — no
  node, no npm, no grin node, no build tools. **Hub install** (`07_lib_hub.sh`) is 91 lines: a bare
  hub is a singlebox with no local stratum, so it reuses the parent's `pool_*` steps and the
  parent's WireGuard menu wholesale.
- Every `.sh` change passes `bash -n` before commit.

---

## 2. Implementation status (verified against `web/07_mining_pool_public/`, 2026-09-07)

✅ done · ⚠ partial · ❌ not built

| Area | Status | Notes |
|---|---|---|
| Ports reconciled `3333/3416/8080` | ✅ | `config.js` (stratum 3333/13333, node upstream 3416/13416, HTTP 8080/8090) — bash + backend in sync. The node upstream is grin's own `stratum_server_addr` default: Script 01 never moves it, so the `3334` an earlier plan named was never implemented. |
| Role split | ✅ | `singlebox` \| `hub` in `config.js`; the app has **no third role**. A gateway runs no Node process at all, so it is not an app role — `07_lib_gateway.sh` deploys HAProxy + WireGuard and nothing else. |
| Stratum proxy | ✅ | `stratum-server.js` (public) + `node-stratum-client.js` (upstream) |
| PROXY-protocol v2 ingress | ✅ | pure-JS parser in `stratum-server.js` (`PROXY_V2_SIG`, 256-byte cap, `absent` → treat as a direct miner). Armed on **region listeners only** — the public `:3333` listener is always raw stratum, so a PROXY header cannot be used there to forge a source IP (audit §J6-3a). |
| Per-region stratum listeners | ✅ | `config.region_ports` `{ "<region>": <port> }`, bound to `region_listen_host` (the WireGuard server IP in prod; loopback by default so a misconfigured box never exposes them). Region is stamped from **which listener the share arrived on**, not from a string the edge sends. |
| Regional gateway deploy | ✅ | `07_lib_gateway.sh` (haproxy `mode tcp` + `send-proxy-v2` + a `stick-table` conn-rate limit, privileges dropped after bind) + `07_lib_gwctl.sh` |
| WireGuard pairing, single mutation path | ✅ | `/usr/local/bin/grin-gateway-ctl` is the ONLY code that edits `/etc/wireguard/wg-grinpool*.conf` **and** `region_ports`, so the peer list and the port map cannot drift. Both callers use it: menu `W` over SSH, and the admin panel via scoped `sudo`. Always emits one JSON object. |
| Multi-region observability | ✅ | `shares.region` column + `pool_locations` table; `GET /api/pool/stats/regions`, `/api/pool/locations`, admin `GET/POST/DELETE /api/admin/locations`, `GET /api/admin/health/gateways` (share recency ∧ wg handshake age → online/stale/offline, plus an active TCP probe of each declared public stratum URL) |
| Public account API | ✅ | `GET /api/account/:addr` (summary), `/balance/log`, `/shares`, `/tor-check`; `POST /api/account/:addr/withdraw` → `WithdrawalScheduler` (CAS lock, 1-pending-per-address **across rails**) |
| Admin miners + testnet inject | ✅ | `GET /api/admin/miners[/:addr]`; `POST /api/admin/miners/:addr/inject` (testnet-only, 403 on mainnet) writes `balance_log` + audit row |
| Local block crediting | ✅ | `stratum-server.js` → `BlockManager.creditBlock`; wired via `index.js setBlockManager`. Gateway shares take the **same** path — they are local shares that arrived on a region listener. |
| PPLNS payout trigger | ✅ | `block-monitor.js distributeConfirmedBlocks` each tick; idempotent `confirmed→paid` in `rewards.js`. Full chain closed: found → credit → mature/verify → confirm → distribute → balance → withdrawal |
| Retention/cleanup | ✅ | `lib/retention.js` scheduled from `index.js`; admin **Settings → Database**; height-floor share prune + age-based hashrate/alert prune |
| Encrypted backup/restore | ✅ | `07_lib_pool_backup.sh` on the shared `gbe_*`/`gbp_*` engine (menu `B`) — DB via the SQLite online-backup API, config, wallet seed, **WireGuard identity**, nginx vhost. Restoring the WG identity means gateways reconnect with zero re-pairing — on their own if the hub keeps its IP; after a hub **IP change** only with a DNS-name endpoint + the gateway re-resolve timer (else `2) Configure` on each gateway), §8.7. A planned move to a new box is `B → 6` Migrate OUT / `B → 7` Migrate IN (§8.7), built 2026-09-23, **not VPS-tested**. |
| White-label / branding / SEO | ✅ | see design §9; `branding.js`, dynamic robots/sitemap/manifest, theme builder |
| Incentives (prize pool/bonus/lottery) | ✅ | `lib/incentives.js`, `lib/lottery.js`; `donate.html`, `fortune-board.html` |
| Asset upload hardening | ✅ | see security audit §A |
| Auth hardening | ✅ | `trust proxy`+`req.ip`; bcrypt 12; account lockout; refresh-token rotation+revocation; `jwt_secret` fail-loud at boot; TOTP step-up (`freshAdmin`) on destructive routes — see security audit §B |
| Service de-rooting | ✅ | runs as `grinpool` under a hardened unit (§1); one scoped sudo target |
| System-health metrics | ✅ | real CPU/mem/disk/uptime via admin `GET /api/admin/health/system`; health page lives in the admin panel |
| Money precision (REAL → nanoGRIN) | ❌ | balances still `REAL` GRIN in `db.js` (`miner_accounts.balance REAL NOT NULL DEFAULT 0.0`) — design follow-up, see D2 |
| Auto-payout scheduler | 🗑 **not built — dead keys deleted 2026-09-25** | Payouts are miner-initiated (account page → Tor/slatepack/Nostr); the scheduler only retries, expires, refunds and reclaims. The inert `payout.auto_payout` and `payout.payout_frequency` keys and their two admin inputs were deleted together (D10, §10.8 F4). A pool that stored them keeps an inert `pool_config` row. |
| Payout chain watch | ✅ **2026-09-25, not VPS-tested** | A paid row gets its kernel only once the pool wallet's tx log shows it **confirmed**. A paid row not seen mined after 1 h raises the rolling `payout_unmined` alert and gets one CLI repost per hour. Admin payments shows `chain_state` per row. §10.8 F1/F2. |
| Tor send method | ✅ **2026-09-25, behind a switch, not VPS-tested** | `payout.tor_send_mode`: `cli` (default, one `grin-wallet send -d`; an exit-0 slatepack fallback is no longer marked paid) or `stepwise` (Owner API steps, slate id saved before any lock). Design §8.1, §10.8 F5. |
| Grin Transporter payout rail | 🗑 **removed 2026-08-13** | never had pool-side code; the dead `lib/wallet-transporter.js` stub went 2026-08-06 and the last two artefacts (`incentives.transporter_enabled` + the disabled admin checkbox) went together on 2026-08-13. The pool ships **Tor primary + Slatepack fallback**, with Goblin/Nostr as an off-by-default operator opt-in ([093 Transporter](script09_design.md) remains a standalone product) |

### Remaining operator responsibility (not code)
- **`grin-server.toml` `wallet_listener_url`** — the node's stratum coinbase must point at the pool
  wallet's combined listener, and it must be a **BASE** url (`http://127.0.0.1:3420`): the node
  appends `/v2/foreign` itself, so a pathed url doubles the path → 404. `pw_patch_node_toml` writes
  the base url. Under Model C there is exactly **one** node and **one** wallet, both on the central
  box, so the old cross-region "which wallet gets the coinbase?" decision no longer exists.
- **The wallet password on disk** (`.wallet_pass`, 600). `owner_api` boots LOCKED and Owner API v3
  only accepts ECDH-encrypted calls, so the only unlock path is `init_secure_api` → `open_wallet`.
  That unlock must be automatic, because in Grin *receiving is a signing op*: the node calls
  `build_coinbase` for every block template (~15 s) and needs the decrypted keychain. A locked
  wallet is not "miss a reward" — it is **no jobs at all** (symptom: miners Alive, GetWorks=0).
  grin-pool (MWGrinPool) and open-grin-pool keep the password in service config the same way.
  Mitigations = low hot balance, sweep to cold; full writeup in the security audit's
  *Residual / accepted risks*. *(Operator decision, not a code gap.)*

### Deferred decisions & open items — read before mainnet

These are **intentionally not coded yet**. Each needs a product call, not more implementation guessing.
Listed here so we don't re-litigate or accidentally re-implement.

| # | Item | Status / why deferred | Recommendation |
|---|---|---|---|
| D1 | **System-health fake metrics** | ✅ **Resolved 2026-06-08** — real metrics via admin `GET /api/admin/health/system`; the health page moved into the admin panel (gated, not public). | Done. |
| D2 | **Money precision `REAL` GRIN → integer nanoGRIN** | Touches all payout/reward/withdrawal/balance_log math + display. High blast radius. **Carve-out landed 2026-07-17:** per-payout network fees are now RECORDED (`withdrawals.fee` — slatepack from the slate, Tor from the wallet tx log) and reconciliation coverage is fee-adjusted, so fee accumulation no longer false-trips `coverage_shortfall`. The REAL→nanoGRIN unit change itself stays deferred. | Do as its **own PR + full testnet soak**, never as a side-change. Engine-independent (do it in SQLite, carries to Postgres). |
| D3 | ~~**mTLS satellite→hub**~~ | 🗑 **Moot since 2026-06-22.** There is no satellite→hub HTTP ingestion to protect: the edge↔central link is a WireGuard tunnel carrying raw stratum, authenticated by the tunnel's own keypair. The shared-secret header and IP allowlist retired with the role. | Closed — do not re-open as stated. |
| D4 | **Grin Transporter payout rail** | ✅ **Closed 2026-08-13 — removed, not deferred.** Blocked indefinitely on a gate the pool does not control: no mainstream wallet can receive from a relay. A placeholder that cannot name a date is a promise, so the reserved `incentives.transporter_enabled` key and its disabled checkbox in `settings-incentives.html` were deleted **in the same commit** — the settings harvester sends every `id` in `.settings-form` (disabled inputs included) and `updateSection` throws on an unknown key, so removing either alone would have broken every Incentives save. | Done. If a relay rail is ever revisited, add it as a self-registering file under `public_html/js/` like `payout-goblin.js` — do **not** re-introduce a reserved settings key ahead of working code. A pool that already persisted `transporter_enabled` keeps an inert `pool_config` row; `getSection` merges stored rows over defaults without a membership check, so it is harmless and no migration is needed. |
| D5 | **Theme-system unification** (public `body.<theme>-theme` → `theme.js` CSS variables) | Cosmetic; refactor risk across 13 themes. | Defer; not launch-blocking. |
| D6 | **i18n / multi-language content** | Product scope; content + tooling. | Defer (phase 2). |
| D7 | **Fiat (USD/EUR/BTC) price display** | Feature; could wire to the Script 06 price collector. | Optional — your call on data source. |
| D8 | **Optional free miner accounts** (true one-person-one-entry lottery) | Conflicts with register-free identity model; partial Sybil trade-off documented (design §9). | Defer (phase 2 design decision). |
| D9 | **Admin theme live-preview iframe + WCAG contrast check** | Admin UX nicety. | Defer; not launch-blocking. |
| D10 | **Auto-payout** | ✅ **Closed 2026-09-25 — dropped for good, keys deleted like D4.** Payouts stay MINER-INITIATED (operator decision 2026-09-24, final). The ownership gate (§10) exists precisely because an ungated automatic trigger was an abuse surface. `payout.auto_payout` + `payout.payout_frequency`, their two inputs in `settings-payout.html` and the `payout_frequency` validator went in **one** change, for the D4 reason (the harvester sends every id, `updateSection` throws on an unknown key). A pool that already stored them keeps inert `pool_config` rows; `test-admin-guards.js` `[7]` proves such a pool still loads and saves. §10.8 F4. | Done. Do not re-introduce a reserved key ahead of working code. |

### Verification still owed by the operator (not changed in code)
Backend items are syntax-checked + logic-reviewed but **not** runtime-tested locally
(`node_modules` live only on the VPS). On a testnet box, confirm:
- a real **login → refresh → old-refresh-replay-rejected** cycle, and **5-fail lockout** then unlock;
- every **admin mutation writes an `admin_audit_log` row** (not line-audited per handler);
- money flow (**orphan reversal exact amounts, idempotent send, CAS balance lock**) against a live DB.

---

## 3. Scheduler jobs

All in-process (no cron except backup + VACUUM). Cadences read from the code, not from settings
unless noted.

| Job | Where | Cadence | Purpose |
|---|---|---|---|
| Block confirmation + distribution | `block-monitor.js` | 30 s | promote pending blocks past `confirm_depth` → `distributeConfirmedBlocks` |
| Orphan detection | `block-monitor.js` | 6 h | nonce-check confirmed blocks; reverse orphans (exact `balance_log` amounts) |
| Withdrawal scheduler loop | `withdrawal-scheduler.js` | 60 s | reclaim stale `finalizing`/`tor_sending` (a stepwise Tor row by its `tor_step`, §10.8 F5), retry queue, Tor checks, slatepack expiry/refund, kernel-proof backfill (confirmed tx-log entries only) + the "paid but not mined" watchdog on the same tx-log read (throttled to 3 min, §10.8 F1/F2). **Freeze-safe:** while frozen it runs only the paths that resolve or refund, never a send, and neither kind of repost. |
| Withdrawal retry ladder | `withdrawal-scheduler.js` | 6/12/24/48 h | `retry_scheduled` rows past `next_retry_at`. **Two uncounted exceptions** (§10.8): a pool-wallet shortfall retries in 1 h and our own tor being down (stepwise only) in 15 min, neither consuming a rung, each capped at 24 before it takes the ladder. |
| Hashrate sampling + hourly rollup | `hashrate-tracker.js` | 60 s / hourly | `hashrate_history`; `rollupCompletedHours()` writes the durable `pool_metrics_hourly` + `pool_region_metrics_hourly` (§9) |
| Retention | `retention.js` | `database.prune_interval_minutes` (default 60; first pass +30 s) | prune raw shares + downsample/age hashrate + prune alerts |
| Alert monitor | `alert-monitor.js` | 60 s (`alert_check_interval_secs`) | health/security alerts |
| Reconciliation + money invariants | `alert-monitor.js` → `reconciliation.js` | 300 s (`alert_money_check_interval_secs`) | coverage/flow/integrity check; can trip the payout freeze |
| Dormancy sweep | `dormancy.js` | 6 h (first pass +60 s) | 24-month abandoned-balance disposition → prize pool |
| Lottery / campaigns | `index.js` | 1 h | reveal committed draws, then run due draws + campaigns |
| Loyalty streaks | `index.js` | 24 h | `incentivesManager.updateStreaks()` |
| Network peer snapshot | `index.js` | 20 min | `snapshotNetworkPeers` — per node (mainnet + testnet when both run on the box) reads `get_connected_peers` **and** `get_peers` (the node's own peer store, stamped with its `last_connected`); the live list alone is ~8 sticky outbound seats, the store is what the node's own background probing (~100 handshakes / 20 s) has verified. Country-only rows in `network_peers`; feeds `/api/network/peers` |
| Stale stratum sessions | `stratum-server.js` | 60 s | `pruneInactiveSessions` |
| miningpoolstats submit | `poolstats-reporter.js` | `poolstats_interval_mins` (default 10) | only when `poolstats_enabled` — **push** mode; the pull feed (§8.6) needs none of this |

There is **no region-aggregation job**: regional shares are written locally by the central stratum
server as they arrive, so nothing has to be pulled from an edge box.
There is **no auto-payout job** (§2, D10).

---

## 4. Database — engine & backup runbook

**Stay on SQLite (Node's built-in `node:sqlite`) now** (one local writer; see design §4 for the
migration triggers). The safe topology is exactly ours: **one local writer process on local disk** —
SQLite does not corrupt on its own; corruption comes from misuse, all avoidable.

The live file is **`/opt/grin/pubpool/<net>/pool.db`** (plus `-wal`/`-shm`). `lib/db.js` chmods all
three to 0600 on every start.

**Rules that prevent corruption:**
- DB on the box's **local SSD** only. Cloud *block* volumes (EBS, DO Volumes) are fine; **never** a
  network filesystem (NFS/SMB).
- One process owns the file (✓ by design); one Node/`node:sqlite` version.
- **Never** `cp`/`rsync` the live `pool.db` — you can capture a torn write.
- **Never VACUUM a live database.** The shipped `/usr/local/bin/<service>-vacuum` (weekly cron,
  menu `C`) stops the service, compacts, and starts it again whatever happens; VACUUM holds an
  EXCLUSIVE lock for the whole rewrite.

**Backups — what actually ships:** menu `B` (`07_lib_pool_backup.sh`) on the shared toolkit engine —
`/opt/grin/backups/grin_pubpool[testnet]_backup_<DDMMYYYY>.tar.gz.enc`, AES-256-CBC/PBKDF2-600k,
password `<personal_key><DDMMYYYY>`, one archive per net per day, optional offsite push. The DB goes
in via the **SQLite online-backup API** (two-phase tar), never a live WAL copy. The set also carries
the config (incl. `region_ports` + `jwt_secret`), the wallet seed/toml/secrets, the **WireGuard
identity**, and the nginx vhost — everything a fresh install cannot regenerate.
Restore runbook: fresh box → Script 01 node → 07 `1) Install` → restore → `grin-secret-sync` →
re-point DNS → gateways: **same IP** → they reconnect on their own; **new IP + DNS-name endpoint +
re-resolve timer** → they follow within ~2–3 min of the DNS change, no action on the gateway box;
**new IP + raw-IP endpoint** → on each gateway `2) Configure` the new endpoint, then `3)`.
*(Corrected 2026-09-23: this line used to promise "no action on any gateway box" unconditionally,
which was true only for the same IP.)* A **planned** move to a new box — as opposed to a disaster
restore — is Migrate OUT / Migrate IN, §8.7. Only the migration archive carries the TLS
certificate; daily archives do not.

**Optional additions (not shipped, operator's call):**
- **Continuous:** [Litestream](https://litestream.io) streams the WAL to S3/B2/another disk →
  point-in-time restore, seconds of RPO.
- **Portable dump (DR/migration):** `sqlite3 pool.db .dump > pool.sql`.
- **Integrity check (nightly cron):** `PRAGMA integrity_check;` → alert if not `ok`.

**Restore (file-level):** `systemctl stop` → replace `pool.db` (or `litestream restore`) →
`systemctl start`.

**Honest limit:** SQLite's real weak spot is **HA/failover** (no built-in hot standby), not
corruption. That is the one legitimate future reason to consider Postgres.

---

## 5. Pre-launch checklist

**Money / consensus**
- [x] `confirm_depth = 1440` mainnet / `100` testnet (= Grin `COINBASE_MATURITY`) — set in code (config.js, pool-settings.js, retention.js, template, admin UI)
- [ ] Found blocks persisted; orphan reversal reverses exact `balance_log` amounts incl. fee, no neg balance
- [ ] PPLNS double-pay guard active (shares marked paid per block in the distribution transaction)
- [ ] Withdrawal balance lock is compare-and-swap; max 1 pending per address **across all rails** (`PENDING_SQL`); wallet send idempotent (`txid`)

**Auth / security** (see [`script07_security_audit.md`](script07_security_audit.md))
- [x] bcrypt ≥ 12; refresh-token revocation; account lockout (`auth.js`/`db.js`) — runtime-verify on testnet
- [x] httpOnly cookie auth (`index.js` login/register). ⚠ still verify the frontend gate `await`s an authenticated endpoint (not `/api/health`)
- [x] `trust proxy` + `req.ip` (no raw `X-Forwarded-For` trust); `jwt_secret` written at install and fail-loud at boot
- [x] Service runs as `grinpool` under the hardened unit; exactly one scoped sudo target
- [x] SVG/upload hardening (§A) + `admin_audit_log` single shape (`migrateAdminAuditLog`). ⚠ still confirm public payments/miners are aggregated/masked

**Infra / ops**
- [ ] Encrypted backup run + **a tested restore** (menu `B`); nightly `integrity_check`
- [ ] Weekly offline VACUUM cron present; graceful SIGTERM verified; HTTPS enforced; secrets only in the pool config
- [x] `bash -n` clean on all `07_*` scripts; `node --check` clean on all backend JS — ⚠ `nginx -t` runs on the VPS
- [ ] 7-day testnet soak before mainnet

---

## 6. Testnet mode

Backend is config-driven; testnet = a different config file + a fully isolated instance
(`/opt/grin/pubpool/testnet/`, config `grin_pubpool_testnet.json`, service
`grin-pool-manager-testnet`, node API `13413`, node stratum upstream `13416`, Central API `8090`,
public stratum `13333`, wallet `13420`, WireGuard iface `wg-grinpool-tn` on udp `51821` with
tunnel net `10.66.67.0/24`, region ports from `13391`). Currency label `tGRIN`; `--testnet` (never `--floonet`); `confirm_depth` defaults to 100;
the admin balance-inject endpoint is testnet-only (guarded). A testnet pool can coexist with a
mainnet pool on one box — it collides only with **solo** mining.

Quick solo/testnet smoke test (IPOLLO): init wallet, patch TOML, start listener + node stratum,
point the miner at `:3333`. (This used to point at an in-repo `grin_mining_testnet_instruction.html`;
that page was deleted on 2026-06-13 in `ea0cc43`. The solo product's own walkthrough is the
"Appendix — Solo private pool flowchart" at the end of [`script07_design.md`](script07_design.md).)

---

## 7. Troubleshooting

| Symptom | Likely cause / check |
|---|---|
| Miners connect but get no work | `NodeStratumClient` needs `pool_address` set, or it can't log in to the node's built-in stratum → no jobs. Verify `config.pool_address` and that the node stratum is up on `127.0.0.1:3416`/`13416`. |
| Miners Alive, **GetWorks = 0**, pool otherwise healthy | The pool wallet is LOCKED. `build_coinbase` needs the decrypted keychain for every template, so a locked wallet halts the whole pool, not just rewards. Re-run the ECDH unlock (`pw_*` autostart/watchdog) — after a crash or reboot the decrypted seed is gone from RAM. |
| Pool hashrate reads ~0 / meaningless | Hashrate is summed accepted-share difficulty over the window (`GPS = sumDiff × 42 / window_s / 16384`), so what each share is CREDITED must be in the chain's unit: job target × the C32 graph weight (16384), `shareCreditDifficulty()` in `stratum-protocol.js`. **This shipped wrong until 2026-09-20** — every share was written at the session's `1.0` vardiff placeholder, so the first live test (8 rigs, ~350 accepted shares) showed 0.00 G/s on every gauge, chart and worker row, and 0 % round effort. `db.js migrateShareCreditUnit` rescales pre-fix rows once (marker `share_credit_c32_units`) so PPLNS weight and luck stay in one unit across the upgrade. Sanity check after a deploy: one rig at job target 1 = `shares_per_min × 0.7 G/s`. |
| Homepage P-03 prints **millions of "SHARES"** after a few hours of one rig; P-04 24H trace shows **no dip** across a mining pause | Two consequences of the share unit above, found 2026-09-21 on grinium.com. (a) `/api/pool/effort.round_shares` is the round's SUMMED difficulty in chain units (the effort numerator, ~16384 per share — `21,544,960 / 16384 = 1315` real shares); the mimic labelled it "SHARES". The endpoint now also returns `round_share_count` (a `COUNT(*)` from the same scan) and the mimic prints that, compact (`1.3 K SHARES`), with the sum on hover. (b) `recordHashrates()` writes a `hashrate_history` row per address WITH a share that minute — a minute with none writes nothing, so a pause is a hole in TIME, and the chart's x-axis is categorical, so the two samples either side of a 3-hour pause sit one step apart and the line simply continues. `getPoolHistory()` now regularizes onto the 60 s sampling grid (`_fillGaps`: absent minute → `0`, from the first sample to now; leading absence left alone so a young pool's trace isn't squashed) before thinning. This is a KNOWN zero — the "draw a null as a gap" rule is for values the server withholds. `getAccountHistory()` (account page chart) has the same hole and is NOT changed. |
| `/api/pool/stats` disagrees with `/api/stratum/stats` (MINERS ONLINE 0 with rigs connected; every account worker "dropped"; stale/reject `–`) | Two `MinerManager` instances. **Was the shipped state until 2026-09-20**: `index.js` and the `StratumServer` constructor each made their own, and the API side's never held a session. `index.js` now injects its instance (`new StratumServer(config, minerManager)`); the constructor's private fallback is for standalone (test) construction only. |
| **100 % stale / reject** on a gateway region | **Never latency — suspect the protocol.** Two real causes, both fixed in-repo and both worth re-checking after any stratum change: the pool must echo the **node's own `job_id`** (jobIdMap, kept for the whole submit window), and the u64 **nonce must travel as a string** (`JSON.parse` rounds past 2^53 — the tell is node-logged nonces ending in zeros). |
| Miner shows "Dead" but the tunnel pings | The gateway's `hub_endpoint` points at the wrong port — e.g. the node stratum (13416) instead of the **assigned central region port** (13391). Diagnose with a raw stratum login over the tunnel (`nc`). Pasting the `GRINGW1\|…` pairing string instead of typing values makes this impossible to mistype. |
| WireGuard handshake fine, **all TCP dead** | Cryptokey-routing (AllowedIPs) mismatch — the classic cause was a duplicate add-peer moving the hub's AllowedIPs to a fresh tunnel IP while the gateway kept the old one. `grin-gateway-ctl add-peer` now refuses to re-add an existing pubkey (it re-prints the pairing string) and a region keeps its port when its box is replaced. To genuinely re-pair: **remove the peer first**, then add. Handshake age proves the tunnel, not the routing. |
| Panel pairing 502s / "saves" nothing while Regions still lists fine | The service unit is missing `/etc/wireguard` from `ReadWritePaths` (or the directory did not exist at service start) — reads work, writes cannot escape the mount namespace even as root (§1). |
| Region shows `unknown` on `/api/admin/health/gateways` | Neither signal is available yet: no share in the last 15 min **and** no wg handshake. A brand-new region declared in the panel before its peer exists reads `unknown`, not `offline`. |
| JWTs invalid after restart / boot refuses to start | `jwt_secret` missing or <32 chars in the pool config — the backend fails loud by design. Re-run the installer/configure step. |
| Allowlist / lockout bypassable | Missing `app.set('trust proxy', 1)` → code trusts spoofable `X-Forwarded-For`. Use `req.ip`. |
| Uploaded logo/icon 404s | `assets_dir` mismatch vs the app working dir, or the `/custom/` nginx alias/permissions. A re-run of `1) Install` chmods the app dir 700 — `pool_ensure_served_dirs` re-opens the two dirs nginx must reach. |
| Node "won't start" after a root run | A root-run node leaves `root:root` files → the `grin` user gets EACCES. Always run as `grin` with `HOME=$GRIN_DIR` (see CLAUDE.md launch contract). |

Diagnostics: `journalctl -u grin-pool-manager[-testnet] -f`; `systemctl status`; test node API per the
CLAUDE.md curl snippets; `sqlite3 pool.db 'PRAGMA integrity_check;'`; on a gateway,
`journalctl -u grin-gateway -f` and `wg show wg-grinpool`.

---

## 8. Multi-region (Model C) — as built

Implemented 2026-06-22 (`f2ebade`, Phases 1–8) and **live-verified on testnet 2026-07-05**: a real
regional gateway forwarded miner hashrate over WireGuard to the central pool, the pool FOUND BLOCKS
from those shares, and the coinbase arrived in the central wallet's combined listener.

**Multi-region is optional and most pools never need it.** A single pool box already serves every
miner on `:3333` as region `main`. Add a gateway only when you have miners on another continent and
want to cut their latency to the stratum endpoint.

### 8.1 Architecture

```
  Miners (Asia)          Miners (US)            Miners (EU)
     │ stratum+tcp :3333     │ :3333                 │ :3333
     ▼                       ▼                       ▼
 ┌──────────────┐     ┌──────────────┐       ┌──────────────┐
 │ Asia Gateway │     │  US Gateway  │       │  EU Gateway  │   thin edge:
 │   HAProxy    │     │   HAProxy    │       │   HAProxy    │   NO node, NO wallet,
 │ (mode tcp)   │     │              │       │              │   NO keys, NO DB, NO Node.js
 └──────┬───────┘     └──────┬───────┘       └──────┬───────┘
        │  WireGuard (wg-grinpool / udp 51820; testnet wg-grinpool-tn / 51821) carrying
        │  raw stratum bytes + PROXY-protocol v2 (real miner IP)
        └────────────────┬───┴───────────────────────┘
                         ▼
 ╔═════════════ CENTRAL BOX (= the single-box pool) ══════════════════════╗
 ║  region listeners 10.66.66.1:3391, :3392 …  ← region stamped by PORT   ║
 ║  public listener :3333 (raw stratum, no PROXY accepted)                ║
 ║        │                                                               ║
 ║        ▼ stratum-server.js → accounting → pool.db (single writer)      ║
 ║        │ stratum CLIENT (localhost) → Grin node 127.0.0.1:3416         ║
 ║        │ node build_coinbase (localhost) → wallet_listener_url         ║
 ║        ▼ grin-wallet :3420 — ONE combined listener (owner_api +        ║
 ║          include_foreign), ECDH auto-unlock → Tor/slatepack payouts    ║
 ╚════════════════════════════════════════════════════════════════════════╝
```

**Region attribution** is by **listener port**, not by a string the edge sends: each gateway's tunnel
targets its own central port (`region_ports`), and the central stratum server stamps that listener's
label on every share. This kills the old "region string must match" footgun outright. The miner's
real IP is recovered from the PROXY-v2 header — which is armed on region listeners **only**, so the
public `:3333` can never be fed a forged header.

**Why the edge is this thin:** no node means no per-region chain sync, no per-region wallet, and no
"which wallet gets the coinbase?" question — `build_coinbase` is a localhost call on the one box that
has both. All accounting stays single-writer on the central DB.

**The honest tradeoff:** every share round-trips edge→central over the tunnel for PoW validation.
Measured 2026-07-05 on a real cross-continent link: fine at Grin's C32 share rate. The 100 %-stale
episodes seen during that test were **protocol bugs, not latency** (§7).

**Not copied from a Grin reference.** Model C is the documented best-practice pattern for
multi-region pools in general (Bitcoin-scale), but no open-source Grin pool publishes this exact
topology — grin-pool is single-region, and the commercial pools' internals are unobservable from
outside. Treat latency/behaviour claims as "measure on a real link".

### 8.2 The pieces

| Piece | Where | Notes |
|---|---|---|
| WireGuard server | central | mainnet `wg-grinpool`, udp **51820**, tunnel net `10.66.66.0/24`; testnet `wg-grinpool-tn`, udp **51821**, `10.66.67.0/24`. Hub is always `.1`, gateways `.2`, `.3`, … Keys/state in `/opt/grin/conf/wg[-testnet]/`. |
| Region ports | central, `region_ports` in the pool config | allocated from **3391** (mainnet) / **13391** (testnet), bound to `region_listen_host` = the wg server IP |
| Pairing string | `GRINGW1\|region\|hub_pubkey\|hub_public_endpoint\|hub_tunnel_ip\|gw_tunnel_ip/32\|region_port\|public_stratum_port` | one line, printed by the pool box; paste it on the gateway instead of typing the values. The 8th field (since 2026-09-20) is the pool's **public miner port** — the gateway must listen on exactly it, so the gateway takes it from here rather than asking. A 7-field string from an older hub still parses (the gateway keeps its saved port); an 8-field string on a pre-2026-09-20 gateway is **rejected** (`read` folds the extra field into `region_port`) — pull both boxes together. |
| Mutation path | `/usr/local/bin/grin-gateway-ctl` (`init-server`/`add-peer`/`remove-peer`/`list`/`status`) | the ONLY writer of `/etc/wireguard/wg-grinpool*.conf` and `region_ports`; validates every input itself and computes AllowedIPs internally (`0.0.0.0/0` is unrepresentable) |
| Operator surfaces | admin panel **Regions & Gateways**, or CLI menu **W** | both call the same helper, so they cannot drift. The panel binds a new listener without the service restart the CLI path needs; the CLI is the SSH/offline fallback. |
| Hub endpoint DNS name | menu `W → 5` | pairing strings then carry a name instead of a raw IP, so a provider/IP change needs only an A-record update — each gateway's re-resolve timer (below) follows it within ~2–3 min, no re-pairing and no restart. The hub prints a warning under every `GRINGW1` string while this is empty. |
| Re-resolve timer (gateway) | `grin-gateway-reresolve` service + timer, installed by gateway `3) Bring up tunnel` | since 2026-09-23. Every 60 s: a hostname endpoint whose handshake is > 135 s old is re-set with `wg set … endpoint`, so WireGuard resolves it again. Existing gateways get it the next time `3)` runs; `5) Status` shows it and warns on an IP-literal endpoint. §8.7. |
| Latency probe (gateway, optional) | gateway `6) Latency probe` → `grin-gateway-probe` | since 2026-09-23. A separate HAProxy on `:443` answering `GET /ping` with 204 for the connect page's browser measurement. §8.7. |

### 8.3 Bring-up order

Start **singlebox** and prove the local pipeline end-to-end *before* adding a gateway. Don't debug
federation and the core pipeline at the same time.

**Pool box** (`07_grin_mining_public_pool.sh` → `1) Pool server`, or `G) Guided Full Setup`):
1. `1) Install` → `2) Configure` (pool name, domain, network, fee, region) → `3) Deploy web files`
   → `4) Setup nginx` → `5) Set up wallet` → `6) Service control` (start) → `7) Create admin`.
2. Only when adding a region: admin panel **Regions & Gateways → Enable multi-region** (or `W → 1`)
   — installs WireGuard, keys, tunnel, firewall, and sets `region_listen_host`.
3. Add the region (panel row, or `W → 2`) → it assigns a tunnel IP + region port and prints **one
   `GRINGW1|…` line**. Copy that.

**Gateway box** (a *different* box — it binds :3333 too), `07_grin_mining_public_pool.sh` →
`2) Regional gateway`:
1. `1) Install` (haproxy + wireguard-tools + python3; generates the keypair — hand its public key to
   the pool box's add-peer step).
2. `2) Configure` → paste the `GRINGW1|…` string (or type region / hub endpoint / tunnel keys).
   The public stratum port it then shows must be the **pool's** public port (`3333` mainnet): the
   admin Regions card appends that shared port to the region's hostname itself, so a gateway
   listening anywhere else is advertised on a port it does not serve. A current pairing string
   carries it (8th field) and pre-fills the prompt; the bracketed value is otherwise whatever was
   saved on this box last time, not a default.
3. `3) Bring up tunnel` (`wg-quick up wg-grinpool` — the gateway box always names its single
   tunnel `wg-grinpool`, whichever network the pool is on) → `4) Service control` → start the forwarder.
4. `5) Status` → tunnel handshake present, `:3333` listening, and `On reboot : forwarder and
   tunnel start automatically`. The two units are enabled by two different steps (`1)` enables
   `grin-gateway`, `3)` enables `wg-quick@wg-grinpool`); a box missing either reboots into
   `:3333` listening with nothing behind it, which the pool's Port check cannot tell from healthy —
   Status names the missing one and the `systemctl enable` that fixes it.

**Miner:** point lolMiner/GMiner/IPOLLO at `stratum+tcp://<gateway-ip>:3333`, username
`<grin_address>.<worker>`. Miners always connect to the public stratum port on their nearest
gateway — region ports are internal plumbing and are never miner-facing.

### 8.4 Scenario matrix

**Layer 1 — bash / deploy**
- Services exist & enabled: `grin-pool-manager[-testnet]` (pool), `grin-gateway` (gateway).
- Configs written 0600: the pool config, `/opt/grin/conf/grin_gateway.json`.
- `jwt_secret` present and **stable across a restart** (not regenerated at boot).
- Ports listening per §11; node built-in stratum is **localhost-only** (`127.0.0.1:3416`, not `0.0.0.0`);
  region listeners bound to the wg IP, **never** `0.0.0.0`.
- `bash -n` clean on all `07_*`; `node --check` clean on backend JS; `nginx -t` OK.

**Layer 2 — backend / money (single box first)**
- Share → PPLNS: submitted shares land in `shares`; a found block matures past `confirm_depth`
  (100 testnet) → `rewards` distributes; `balance_log` gets append-only rows; no share paid twice.
- Orphan path: mark a confirmed block's nonce absent from chain → reversal reverses the **exact**
  `balance_log` amounts (incl. fee), balance never < 0.
- Withdrawal: CAS balance lock (insufficient → `409`); max 1 pending per address across rails
  (`429`); idempotent send (`txid`); reversal cooldown blocks an immediate re-request.
- Ownership gate: a withdraw/finalize without a valid `proof` is refused (§10).
- Auth: login → refresh → **old refresh replay rejected**; 5-fail **lockout** then unlock; every
  admin mutation writes an `admin_audit_log` row.

**Layer 3 — multi-region (pool + one gateway)**
- A share submitted through the gateway appears in the central `shares` table tagged with **that
  region**, and `miner_ip` is the miner's real address (from PROXY-v2), not the gateway's.
- `GET /api/pool/stats/regions` shows the region's GPS/miners/shares; `/api/pool/locations` shows
  its label + public stratum URL; `GET /api/admin/health/gateways` reports it `online` with a
  recent `tunnel_handshake_age` and `stratum_reachable: true`.
- Blocks found from gateway shares credit exactly like local ones (same code path).
- Tunnel-outage drill: stop the tunnel → miners on that gateway disconnect (there is **no edge
  buffer** by design — the edge holds no state) → region goes `stale` then `offline` → bring it
  back and miners reconnect. Nothing to reconcile, because nothing was staged.
- Re-pair drill: `remove-peer` then `add-peer` (never a duplicate add) — and confirm the region
  keeps its port when only the gateway **box** is replaced.

**Layer 4 — frontend / public**
- Public pages render live: home stats, `/blocks`, `/payments` (aggregated), `/miners` (masked
  addresses), an account page for a real address, the connect grid showing every active region.
- Admin: login over HTTPS sets httpOnly cookies; dashboard/withdrawals/settings/Regions load;
  testnet currency label shows `tGRIN`.
- XSS: a worker name / address with HTML metacharacters renders escaped.

**Failure drills (must all degrade safely):** tunnel down (above) · node stratum down (*Miners connect
but get no work*, §7) · wallet locked (*GetWorks = 0*, §7) · DB `PRAGMA integrity_check` not `ok` ·
`systemctl stop` flushes WAL cleanly (no `-wal`/`-shm` growth after stop).

### 8.5 Endpoint reality check — verified against `back-end-pool/index.js` (2026-09-07)

| Endpoint | State | Notes for testing |
|---|---|---|
| `GET /api/health` | ✅ alias of `/health` | either path works |
| `GET /api/pool/stats/regions` | ✅ | per-region GPS/miners/shares over a 15-min window, joined onto `pool_locations` |
| `GET /api/pool/locations` | ✅ | public list of active regions (region/label/stratum_url, grouped by country) |
| `GET /api/admin/health/gateways` | ✅ | per-region liveness: `min(share age, wg handshake age)` → online (<180 s) / stale / offline (≥600 s) / `unknown` when neither signal exists, plus a 2.5 s TCP probe of each declared public stratum URL |
| `GET/POST/DELETE /api/admin/locations` | ✅ | CRUD on `pool_locations` (upsert by `region`); audit-logged. **Metadata only** — the real wiring is the wg peer + region port |
| `GET /api/admin/gateways/server`, `POST /api/admin/gateways/server`, `GET /api/admin/gateways/:region/pairing` | ✅ | panel-side `init-server` / pairing-string retrieval via scoped `sudo grin-gateway-ctl`; the POST is `freshAdmin` (step-up gated) |
| `POST /api/shares`, `POST /api/blocks` | 🗑 **gone** | the satellite ingestion API. Removed 2026-06-22 with the role; there is no shared-secret header and no IP allowlist any more. A gateway sends **stratum bytes over a tunnel**, not HTTP. |
| `GET /api/admin/health/satellites` | 🗑 **gone** | replaced by `/api/admin/health/gateways` |
| `POST /api/account/:addr/withdraw` | ✅ (tor · slatepack · nostr) | `{ amount, method, proof }`; CAS lock in `WithdrawalScheduler`; 409 insufficient / 429 already-pending (any rail) / 400 below min |
| `GET /api/account/:addr` · `/balance/log` · `/shares` · `/tor-check` | ✅ | summary (balance/paid/pending/shares/hashrate, `payouts_frozen`, `has_recorded_ip`/`has_recorded_pass`), append-only ledger, Tor reachability (tri-state; `?fresh=1` re-probes past a 10 s floor — §10.5) |
| testnet `POST /api/admin/miners/:addr/inject` | ✅ testnet-only (403 on mainnet) | the "skip the maturity wait" shortcut; credits balance + writes `balance_log` + audit row |
| `POST /api/account/:addr/min-payout` | 🗑 **gone** | per-account threshold retired 2026-07-17 (§10); only pool-wide `min_withdrawal` applies |
| `POST /api/account/:addr/cancel` (public cancel) | 🗑 **gone** | removed 2026-07-17 (§10.1) — both parked states self-recover; admin cancel is step-up gated |
| `GET/POST /api/claim/:id` (slatepack claim rail) | ❌ never built | the slatepack rail ships through the withdraw route, not a claim endpoint |
| `GET/PUT /api/admin/users[/:id]`, `PUT /api/admin/miners/:addr` | ❌ still absent | legacy `admin-panel/users.html` references some; not required by the primary dashboard |
| `GET /api/admin/health/system` | ✅ | real host CPU/mem/disk/uptime |

### 8.6 Copy-paste smoke tests

Run on the box. Set the vars once. `$NET=mainnet` or `testnet`; ports per §11.

```bash
# ── vars ──────────────────────────────────────────────────────────────────────
NET=testnet                        # or mainnet
API=127.0.0.1:8090                 # Central API, local to the pool box (mainnet: 8080)
CONF=/opt/grin/conf/grin_pubpool_testnet.json      # mainnet: grin_pubpool.json
DB=/opt/grin/pubpool/$NET/pool.db
ADDR=tgrin1exampleaddressxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
ADMIN_USER=admin; ADMIN_PASS='your-admin-password'

# ── ports listening (pool box: API + public stratum + region ports on the wg IP) ─
ss -tlnp | grep -E ':(3333|13333|3416|13416|8080|8090|3391|13391|443)\b'
ss -ulnp | grep -E ':5182[01]\b'                    # WireGuard (mainnet 51820 / testnet 51821)

# ── 1) health + public reads (no auth) ─────────────────────────────────────────
curl -s http://$API/health                  # /health and /api/health both work
curl -s http://$API/api/config/pool-info
curl -s http://$API/api/pool/stats
curl -s http://$API/api/pool/stats/regions   # per-region GPS/miners/shares
curl -s http://$API/api/pool/locations       # operator-declared active regions
curl -s http://$API/api/stratum/stats
curl -s http://$API/api/stratum/hashrate
curl -s http://$API/api/pool/blocks
curl -s http://$API/api/pool/miners           # balance distribution — addresses MASKED since 2026-07-28
curl -s http://$API/api/pool/payments
# REMOVED 2026-07-28: /api/miners/top (public rich-list, see security audit §C1) and
# /api/account/$ADDR/balance (every field of it is already in /api/account/$ADDR).
curl -s http://$API/api/pool/poolstats        # pool-directory listing feed (see 1c below)
curl -s http://$API/api/public/branding
curl -s http://$API/api/public/endpoints      # the live API reference api-docs.html renders
curl -s http://$API/api/account/$ADDR        # summary (404 until the addr has shares)
curl -s http://$API/api/account/$ADDR/balance/log
curl -s http://$API/api/account/$ADDR/shares
curl -s http://$API/api/account/$ADDR/tor-check           # 60 s cache; can take ~30 s cold
curl -s "http://$API/api/account/$ADDR/tor-check?fresh=1" # re-probe (answers <10 s old are served as-is)
# online: true = a wallet answered · false = our tor works, the wallet did not · null = OUR tor
# could not look (a Tor payout is still allowed). `reason` names which — impl §10.5.

# ── 1c) Getting listed on miningpoolstats.stream/grin ───────────────────────────
# The pool is listed by PULL, not push: they poll a URL, we publish one. Hand them
#     https://<your-pool-domain>/api/pool/poolstats
# and nothing else — no file to generate, no cron, no auth carve-out (it is aggregates only,
# so it is safe unauthenticated). Listings are added by a human at MPS on request; there is no
# auto-discovery, so publishing the URL alone gets you nothing until you contact them.
#
# WHY THE SHAPE LOOKS LIKE THE SOLO FEED: it is a field-for-field mirror of solo's
# poolstats_<net>.json (scripts/lib/07_mining_block_collector.py build_poolstats). If MPS has
# already imported the solo feed, they have a working parser and need no new adapter. Adding
# fields is safe; renaming or dropping one breaks their importer. Two fields are additive-only
# extras here: pool.url and pool.reward_model.
#
# REFRESH: recomputed at most once per 60s and served from an in-process cache in between, so
# polling faster than 1/min returns byte-identical output. 1–5 min is the sensible poll range.
# (Solo's file is regenerated every 5 min by cron, so the pool feed is the fresher of the two.)
# The `ts` field is the generation time — if it stops advancing, the feed is stale.
# On a backend error the last good body is served for up to 15 min, then the endpoint 500s
# rather than serving a frozen feed forever: a listing that silently stops updating is worse
# than one that visibly goes down, because nobody notices the first.
#
# NULL vs 0 — do not treat them the same: network.* is null when the node is unreachable, and
# network.hashrate_gps_24h stays null until pool_metrics_hourly has an hour of samples (it does
# not backfill). pool.last_block is null until the pool finds its first non-orphaned block.
curl -s https://$DOMAIN/api/pool/poolstats | python3 -m json.tool
# Sanity before sending the URL: net matches the network you think you deployed, pool.name is
# not still the default, and pool.url is set (it comes from config.subdomain — blank if the
# installer never recorded a domain, which makes the listing link nowhere).

# ── 1b) API reference contract (api-docs.html) ──────────────────────────────────
# The endpoint LIST is derived from the live Express route table, so it cannot drift: a new
# route under PUBLIC_API_PREFIXES appears by itself, a deleted one disappears. The per-endpoint
# NOTES are hand-maintained in API_DOC_META and CAN drift. When you add a public route, add its
# meta entry in the same commit — desc + shape at minimum. `shape` is not decoration: this API
# is NOT uniform (newer /api/public/* routes return { success, data }, most older ones return
# the payload raw or as a bare array, and errors are ALWAYS { error } with no success flag), and
# the page publishes the real shape per row rather than one blanket claim that is wrong for most
# of them.
#
# Drift check — runs on the SOURCE, so it needs no server and works before you deploy. Fails if a
# public route has no meta entry, or a meta entry names a route that no longer exists. The meta
# regex is LINE-ANCHORED (^\s*'KEY':) on purpose: unanchored it also matched "POST /api/account"
# inside a description that cross-references another route and reported a dead entry that did
# not exist (2026-09-21). It checks KEYS only — the notes on each row are still read by hand,
# and that hand-read is what found a route labelled `raw` that returns a bare array, a body line
# that named one proof where the handler demands two, and an endpoint that had always answered `{}`.
node -e '
const src=require("fs").readFileSync("index.js","utf8");
const pf=src.slice(src.indexOf("const PUBLIC_API_PREFIXES = ["));
const P=[...pf.slice(0,pf.indexOf("];")).matchAll(/.(\/api\/[^"'"'"']+)./g)].map(m=>m[1]);
const R=[...src.matchAll(/app\.(get|post|put|delete|patch)\(\s*.([^"'"'"']+)./g)]
  .map(m=>m[1].toUpperCase()+" "+m[2]).filter(k=>P.some(p=>k.split(" ")[1].startsWith(p)));
const b=src.slice(src.indexOf("const API_DOC_META = {"));
const M=new Set([...b.slice(0,b.indexOf("\n  };")).matchAll(/^\s*.((?:GET|POST|PUT|DELETE|PATCH) \/api\/[^"'"'"']+).:/gm)].map(m=>m[1]));
const miss=R.filter(k=>!M.has(k)), dead=[...M].filter(k=>!R.includes(k));
console.log("routes",R.length,"meta",M.size,"| undocumented",miss.length,miss,"| dead",dead.length,dead);
process.exit(miss.length||dead.length?1:0);'

curl -s http://$API/api/public/endpoints | python3 -m json.tool | head -40

# ── 2) admin auth (httpOnly cookies) ────────────────────────────────────────────
curl -s -c /tmp/pool-cookies.txt -X POST http://$API/api/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASS\"}"
C='-b /tmp/pool-cookies.txt'
curl -s $C http://$API/api/admin/dashboard
curl -s $C http://$API/api/admin/audit-log            # expect a login_success row
curl -s $C http://$API/api/admin/health/system        # real CPU/mem/disk/uptime
curl -s $C http://$API/api/admin/health/gateways      # per-region liveness (see §8.5)
curl -s $C http://$API/api/admin/miners
curl -s $C "http://$API/api/admin/miners/$ADDR"
# region registry CRUD (upsert → list → the public surface reflects it)
curl -s $C -X POST http://$API/api/admin/locations -H 'Content-Type: application/json' \
  -d '{"region":"us-east","label":"US East","stratum_url":"us.example.com:3333","is_active":true}'
curl -s $C http://$API/api/admin/locations

# ── 2b) testnet-only: inject balance + drive a withdrawal end-to-end ─────────────
# inject is hard-guarded to testnet (403 on mainnet) — skips the confirm_depth wait.
curl -s $C -X POST "http://$API/api/admin/miners/$ADDR/inject" \
  -H 'Content-Type: application/json' -d '{"amount":25}'
# now the address has balance → trigger a payout. `proof` is the ownership gate (§10):
# any mining IP *or* stratum password in this address's proof set (up to 10 of each, §10.4).
curl -s -X POST "http://$API/api/account/$ADDR/withdraw" \
  -H 'Content-Type: application/json' \
  -d '{"amount":10,"method":"tor","proof":"203.0.113.9"}'
# CAS guards: a second concurrent request → 429 (pending on ANY rail); over-balance → 409
curl -s $C http://$API/api/admin/withdrawals       # the new withdrawal should appear

# ── 3) DB-layer checks (cross-check the region aggregates) ──────────────────────
sqlite3 "$DB" 'PRAGMA integrity_check;'
sqlite3 "$DB" "SELECT region,COUNT(*) FROM shares GROUP BY region;"   # matches /api/pool/stats/regions
sqlite3 "$DB" 'SELECT grin_address,balance,balance_locked FROM miner_accounts LIMIT 5;'
sqlite3 "$DB" 'SELECT height,status,found_by FROM blocks ORDER BY height DESC LIMIT 5;'
sqlite3 "$DB" "SELECT event_type,reference_type,amount FROM balance_log ORDER BY id DESC LIMIT 5;"

# ── 4) multi-region: central side ──────────────────────────────────────────────
sudo grin-gateway-ctl list   --net $NET | python3 -m json.tool   # regions + pairing strings
sudo grin-gateway-ctl status --net $NET | python3 -m json.tool   # per-region handshake + rx/tx
wg show wg-grinpool          # testnet: wg-grinpool-tn
python3 -c "import json;print(json.load(open('$CONF')).get('region_ports'))"

# ── 5) multi-region: gateway side (on the GATEWAY box) ─────────────────────────
systemctl is-active grin-gateway
journalctl -u grin-gateway -n 30 --no-pager
wg show wg-grinpool latest-handshakes           # a handshake proves the tunnel, NOT the routing
python3 -c "import json;print(json.load(open('/opt/grin/conf/grin_gateway.json')))"
# raw stratum login straight down the tunnel — proves hub_endpoint points at the RIGHT port
printf '{"id":"1","jsonrpc":"2.0","method":"login","params":{"login":"%s","pass":"x","agent":"nc"}}\n' "$ADDR" \
  | nc -w 5 <hub_tunnel_ip> <region_port>

# ── logs ─────────────────────────────────────────────────────────────────────
journalctl -u grin-pool-manager${NET:+-$NET} -n 50 --no-pager
```

> Payouts can't be smoke-tested by a single curl beyond creation (the rest is scheduler-driven and
> needs a matured block + a reachable miner listener). Validate during the 7-day soak: confirm a real
> block, wait `confirm_depth`, request a payout, watch the row reach `confirmed` with a `txid` and a
> kernel proof, then verify the reversal/CAS branches per Layer 2.

### 8.7 Hub move (Migrate OUT / IN) + connect-page latency — as built (2026-09-23, uncommitted, NOT VPS-tested)

Built in seven parts on 2026-09-23 for the move of the mainnet hub from New York to OVH Gravelines.
The *why* — effective latency, the F1/F2/F3/F4 traps, the step order — is design §4 and §13.13.
**Nothing here has run on a VPS.** The adversarial review ran the same day (audit Status roll-up,
"Part 9 review"): seven fixes (six on 2026-09-23, P1 on 2026-09-24), listed under *Part 9 review
fixes* at the end of this section.
`npm test` 960 (16 suites) → **1133 (19 suites)**, re-run 1133/1133 by the doc-fold session.

#### Files

| File | New / changed | What |
|---|---|---|
| `scripts/lib/07_lib_pool_migrate.sh` | NEW (`pmg_`) | Migrate OUT + Migrate IN. Sourced at the END of `07_lib_pool_backup.sh`, so the pool script does not source it itself. |
| `scripts/lib/07_lib_pool_backup.sh` | changed | shared cores: `pbk_freeze_payouts <db> <reason> <by>` (restore + both migrate halves), `_pbk_build_archive <strict>` (Backup now = lenient, migrate = strict), `_pbk_restore_extract` + `_pbk_restore_perms`, `_pbk_cert_paths` behind `PBK_INCLUDE_CERTS` (a global `0`, raised by a `local` in `pmg_migrate_out` only). Header, runbook and menu line rewritten to the three reconnect cases. Part 9: `_pbk_code_excludes` (never archive or extract `index.js`/`package*.json`), `_pbk_make_tar` rc 2 = pool.db not in the archive (fatal in both modes; the cron wrapper exits 1), `PBK_EXTRACT_FROZEN` + a freeze on a failed extraction. |
| `scripts/lib/07_lib_gateway.sh` | changed | `gw_install_reresolve` / `gw_remove_reresolve`; menu `6) Latency probe` (`gw_render_probe`, `gw_probe_remove`, enable / renew / disable); `gw_status` Re-resolve + Probe lines; shared `_gw_fw_open_tcp` and `_gw_haproxy_account` (the forwarder cfg renders byte-identical to before). |
| `scripts/07_grin_mining_public_pool.sh` | changed | `_pool_pairing_ip_warning` under the three CLI `GRINGW1` prints; `_pool_nginx_ping_block`, `_pool_latency_probe_domain`, `_pool_latency_hub_host`; page CSP `connect-src` + `https://*.<probe_domain>`; optional `latency_hub_url` cert + server block in `pool_setup_nginx`. Cleanup 3b also removes the re-resolve timer and the probe. |
| `back-end-pool/lib/db.js` | changed | `SEED_VERSION = 3` (`hkg`, `sin`, `cqf`); `ensureLocalRegion` stamps/reads `pool_config` `_state`/`local_region`. |
| `back-end-pool/lib/region-rtt.js` | NEW, pure | rolling window (last 5 successful) → `hub_rtt_ms` = min, integer; `0` for the hub row; `null` with no sample. |
| `back-end-pool/lib/connect-suggest.js` | NEW, pure | `estimate()` + `pickRecommended()`; `DEFAULT_K = 0.015` ms/km, `DEFAULT_DIRECT_BIAS_MS = 15`. |
| `back-end-pool/lib/latency-probe.js` | NEW, pure | `probeDomain`, `hubHost`, `latencyConfig`; `HOST_RE` = the shell's `_POOL_HOST_RE`, pinned by a test. |
| `back-end-pool/index.js` | changed | `publicRegionStatus()` lifted to module level (shared by `/stats/regions` and suggest); `probeStratumTcp` clock restarts on `lookup`/`connectionAttempt` (excludes DNS and dead IPv6 tries — also lowers the admin `stratum_probe_ms` slightly); the suggest route; `connection.latency` on branding; `API_DOC_META` rows. |
| `public_html/js/reactor-dashboard.js`, `css/reactor.css` | changed | suggestion badge, `~NN ms` estimates, browser measurement, Re-test control. |
| `scripts/test-regions.js`, `test-connect-suggest.js`, `test-latency-probe.js` | NEW | wired into `test:unit`. |

#### Menu keys

- **Pool `B` (backup):** `6) Migrate OUT` (this hub → a new box), `7) Migrate IN` (new box; offers
  `CHECK` for read-only box checks, or `MIGRATE`). Both dispatch `|| true`.
- **Gateway:** `3) Bring up tunnel` now also installs and enables the re-resolve timer (non-fatal
  if that fails). `6) Latency probe` → `1` enable / change host · `2` renew now (a staging
  `--dry-run` first; then `--force-renewal` on `y` — Let's Encrypt allows 5 per week) · `3` disable.
- **Hub `W → 5`** is unchanged, but now matters for every move: with it empty, the CLI prints a
  warning under each pairing string.

#### Config keys

| Key | Where | Meaning |
|---|---|---|
| `probe_host` | gateway `grin_gateway.json` | the probe's DNS name (its A record must be this box or its ipify public IP) |
| `probe_enabled` | gateway `grin_gateway.json` | `"1"` / `"0"` |
| `latency_probe_domain` | hub `pool.json`, optional | the domain whose subdomains the page may time. Default = the pool's `subdomain`, **never derived wider**; an override is honoured only if it equals the subdomain or is a parent of it (`pool.x.com` → `x.com`). |
| `latency_hub_url` | hub `pool.json`, optional | `https://<host>[/ping]` under the probe domain, not the site's own name or `www`, no port/query. For a hub behind a CDN: a DNS-only name that gets its own cert and a `/ping`-only server block. Unset + CDN → the hub is not timed (keeps its estimate). |
| `wg_endpoint_host` | hub `pool.json` (existing, `W → 5`) | a DNS name here is what makes a hub IP change automatic for gateways |
| `_state` / `local_region` | `pool_config` table in `pool.db` | the local region this DB last ran as (F3 stamp). Not operator-edited. |

#### Endpoints

- **`GET /api/pool/stats/regions`** — each row gains `is_hub` (bool; true on the `singlebox`'s own
  region — a `hub` role has no such row) and `hub_rtt_ms` (int ms; `0` on the hub row; `null`
  until a first successful probe).
- **`GET /api/pool/connect/suggest`** — public limiter, `Cache-Control: private, no-store`. Answers
  `{ basis: 'estimate', recommended, estimates: [{ region, est_ms, via: 'direct'|'gateway' }] }`,
  or `{ basis: 'unavailable' }` alone when there is no geo-IP, no country or no centroid. No log,
  no write; neither the IP nor the country is echoed. 500 → `{ error: 'Failed to build a suggestion' }`.
- **`GET /api/public/branding`** → `data.connection.latency = { probe_domain, hub_url, direct_bias_ms }`.
  `hub_url` is `'/ping'` (same origin), `'https://host/ping'`, or `null` (do not time direct).
  No latency object → the page measures nothing.
- **`/ping`** — hub: a location in the main vhost (and in the optional `latency_hub_url` block,
  which 404s everything else); gateway: the `grin-gateway-probe` HAProxy. Both: empty **204** to
  `GET`/`HEAD` (+ `OPTIONS` on the gateway), any query string allowed, `ACAO *`,
  `Timing-Allow-Origin *`, `Cache-Control: no-store`, no access log. Rate limits: hub `_static`
  zone burst 20; gateway 30 requests / 10 s per IP, then 429.

#### Files on the boxes

- **Gateway:** `/usr/local/bin/grin-gateway-reresolve`, `/etc/systemd/system/grin-gateway-reresolve.{service,timer}`
  (OnBootSec 2 min, every 60 s, AccuracySec 5 s; root, `CapabilityBoundingSet=CAP_NET_ADMIN`,
  `ProtectSystem=strict`, deliberately **no** `PrivateNetwork`/`PrivateDevices`). Probe:
  `/opt/grin/gateway/probe.cfg`, `/opt/grin/gateway/probe.pem` (0600 root — HAProxy loads it before
  dropping root), unit `grin-gateway-probe`, certbot deploy hook
  `/etc/letsencrypt/renewal-hooks/deploy/grin-gateway-probe.sh` (acts on its own lineage only,
  `try-restart`s the probe, never the forwarder). Logs: `journalctl -t grin-gateway-reresolve`
  (one line only when the endpoint changed).
- **Hub:** `$POOL_APP_DIR/migration_manifest.json` (0600 grinpool; renamed
  `migration_manifest.applied-<UTC>.json` by IN once the pool starts); the archive
  `/opt/grin/backups/grin_<product>_backup_<DDMMYYYY>.tar.gz.enc` (local date) + `<archive>.sha256`.

#### Migration manifest (schema 1)

`kind`, `created_at`/`created_at_unix`, `net`, `product` (`pubpool`/`pubpooltestnet`),
`archive_name`, `source{hostname, public_ip, mode}`, `pool{domain, stratum_port, local_region,
local_region_stamp, local_region_row{stratum_url, is_active}, cloudflare_proxy}`,
`wireguard{iface, listen_port, endpoint_host}`, `node{height}`, `wallet{ok, error, height,
refreshed_from_node, total, awaiting_confirmation, awaiting_finalization, immature, locked,
spendable}` (amounts are strings as grin-wallet printed them), `wallet_identity`,
`ledger{accounts{count, balance_sum, balance_locked_sum}, shares{count, max_id, latest_at},
blocks{count, max_id}, withdrawals{count, max_id, in_flight_count, in_flight_amount},
balance_log{count, max_id}}` plus **per-row sha256 digests** of accounts, blocks, withdrawals and
balance_log (explicit columns, never `SELECT *`), `in_flight_statuses{sql, source}`,
`payout_control{before, after}`, `certs_included`.
- `local_region_stamp: null` → IN writes the old tag as the stamp itself (design §13.13.2).
- `archive_name` is computed one step before the archive: a run straddling local midnight differs
  by one day. Treat ±1 day as a warning.
- IN compares with the **manifest's** in-flight SQL, and a figure absent from the manifest is
  `skip`, never `ok`.

#### Operator runbook — the move

*Days before*
1. Deploy the new code to the old hub, the new box and every gateway. On each gateway run
   `3) Bring up tunnel` once (installs the re-resolve timer). On the hub, `W → 5` = a DNS name;
   re-pair any gateway still on a raw IP (its `5) Status` warns).
2. TTL 60 s on every record that will move, ≥ 48 h ahead.
3. New box: Script 01 node, synced → pool `1) Install` **only** (never `5)` wallet) →
   `grin-secret-sync` → restart the node, let it sync → open 80/443/3333 tcp + 51820 udp.
4. New box: `B → 7` → `CHECK` until READY. Have the personal backup key to hand.

*Cutover (a low-hashrate hour. Migrate OUT turns the weekly VACUUM cron off and refuses while a
vacuum runs — its EXIT trap restarts a pool it stopped, review P1 — so a Sunday 03:00 UTC start only
costs a wait)*

5. **Old hub:** `B → 6` → `MIGRATE` (+ `PROCEED` if withdrawals are in flight) → push to
   `root@<new>` → note the sha256.
6. **New box:** `B → 7` → `MIGRATE` → Enter (the `[migration]` archive) → key → `RESTORE` → `y` and
   the new location (for Gravelines: `cqf` / Gravelines / France / FR / `50.98,2.13`) → continuity
   all ✓ → start.
7. Change exactly the DNS records it lists.
8. Watch until every gateway is ✓. A raw-IP gateway: `2) Configure` the new endpoint, then `3)`.

*After*

9. Admin → Regions: the new region active; the old one deactivated or re-pointed.
10. Reconcile clean → **unfreeze in admin → Payouts** (IN never unfreezes) → one small payout per rail.
11. Copy the migration archive off-box first — the next `B → 3` daily backup **replaces** today's
    archive of the same name — then `B → 4 → 1` key, `B → 3` daily.
12. Keep the old box dark ~7 days, then wipe it (seed + WG key). It may be rebuilt as the `nyc`
    gateway; its seeded row is untouched.

**Rollback** (printed by both halves) is valid only until the new hub accepts a share or pays:
`systemctl enable --now wg-quick@<iface>`, `env SHELL=/bin/bash <wallet dir>/pool-wallet-boot.sh`,
`systemctl enable --now <pool service>`, then pool menu `5) → 6) e` + `7) i`, `B → 3`; reconcile,
then resume in admin → Payouts.

**Expected miner downtime — an estimate, never measured:** ~15–30 min (OUT 3–8 + IN 5–12 + DNS 1–5
at TTL 60; gateways +2–3 min after DNS). The testnet rehearsal must measure it.

#### Smoke tests (latency)

```bash
# Hub /ping (same origin) — expect 204, ACAO *, Timing-Allow-Origin *, no-store
curl -sI "https://$POOL_DOMAIN/ping"
# Gateway probe (after 6) → 1) — expect 204; POST → 404; > 30 req / 10 s → 429
curl -sI "https://hkg.$POOL_DOMAIN/ping"
# Regions carry is_hub + hub_rtt_ms; suggest answers an estimate (or basis:unavailable without geo-IP)
curl -s "https://$POOL_DOMAIN/api/pool/stats/regions" | python3 -m json.tool | grep -E '"(region|is_hub|hub_rtt_ms)"'
curl -s "https://$POOL_DOMAIN/api/pool/connect/suggest"
# Gateway: re-resolve timer present and quiet
systemctl list-timers grin-gateway-reresolve.timer; journalctl -t grin-gateway-reresolve -n 20
```

#### How it was tested (locally — no VPS)

Unit suites: `test-regions.js` (seeds v3, the F3 stamp, `hub_rtt_ms`), `test-connect-suggest.js`
(calibration, effective latency, the bias, exclusions, the in-country floor, the route text, and the
page's copy of `pickRecommended` run against the lib on 2,000 generated cases),
`test-latency-probe.js` (probe domain never wider, hub host forms, the branding key set, and the
shell's CSP / named-location / cert-gated block text). Each carries revert-proofs recorded by its
build session. The bash halves and the browser were tested in throwaway harnesses outside the repo:
fake `wg`/`systemctl`/`certbot`/… on PATH through the real libs, a WSL run with **real nginx 1.24
and HAProxy 2.8** for the `/ping` blocks, a Migrate OUT → wipe → Migrate IN run on a fixture
(19 scenarios, incl. a swapped-balances case that sums alone would pass), and headless Chrome for
the connect page (estimate → measured, CDN hub, dead gateway, sessionStorage blocked, 390 px).
**None of this proves a real systemd, a real certbot issue, a real DNS flip or a real move** — that
is the VPS acceptance still owed.

#### Part 9 review fixes (2026-09-23, uncommitted, NOT VPS-tested)

The findings table and the plausible items are in the audit Status roll-up ("Part 9 review"). What
changed in the code:

| # | Where | Change |
|---|---|---|
| C1 | `_pmg_out_manifest` / `_pmg_out_archive` | `PMG_MANIFEST_ARCHIVE` holds the name the manifest promised; if the built archive's name differs (local midnight between steps 5 and 6), the manifest is rewritten and the archive rebuilt once, to the same file name. A second mismatch fails step 6. |
| C2 | `_pmg_in_restore` | `systemctl disable $POOL_SERVICE` before `_pbk_restore_extract`; refuses (nothing restored) if the unit is still enabled. Step 7 enables it as before. |
| C3 | `_pbk_code_excludes` (new), `_pbk_make_tar`, `_pbk_restore_extract`, the cron wrapper | `index.js`, `package.json`, `package-lock.json` at the top of the app dir are never archived and never extracted. |
| C4 | `_pbk_restore_extract`, `pbk_restore`, `_pmg_in_restore` | a failed extraction freezes whatever pool.db is in place (same reason/by as the caller's), `PBK_EXTRACT_FROZEN` = 1/0 on every path; `2) Restore` prints frozen / NOT frozen and runs `_pbk_restore_perms`; IN's inline freeze removed. |
| C5 | `_pbk_make_tar`, `_pbk_build_archive`, the cron wrapper | pool.db present but not staged / snapshotted / appended → `_pbk_make_tar` rc 2, which `_pbk_build_archive` treats as fatal in BOTH modes (nothing encrypted); the wrapper's `dbfail` logs `ERROR … no archive written` and exits 1. |
| C6 | `_pmg_tcp_probe`, `_pmg_https_probe`, `_pmg_in_dark_probe` | TCP: rc 1 only on `Connection refused` (stderr read under `LC_ALL=C`), everything else but a connect is rc 2. HTTPS: rc 1 only when an HTTP status came back and it is not a parsed `status: ok`; curl failing to connect / TLS / empty reply is rc 2. No domain in the manifest → the API leg is rc 2. Dark = both rc 1. |

**Verified (locally, Git-bash — no VPS):** the Part 4 harness extended with scenarios `midnight`,
`filtered` (no-route stratum + no HTTP on 443), `nohttp` (RST + no HTTP), `restorefail`, `infail`,
`nodb`, and new assertions on `happy`/`restore`/`wallet`/`swap`/`restart` (fixture now models
`1) Install` enabling the unit and a newer checkout on the new box). **Red first:** 14 of the new
assertions failed on the unfixed code. **After:** 126/126 across 25 scenarios (the original 91
across 19 still pass). Daily cron wrapper rendered through the real lib and run with a fake PATH:
6/6 (normal archive carries pool.db and no `index.js`; a failed snapshot stage writes nothing and
logs `ERROR`); `bash -n` on the rendered wrapper. Part 3's Migrate OUT harness (7 scenarios):
same exit codes, and the recorded effect order byte-identical to before the fixes. `npm test`
1133 → 1133 (19 suites; no JS changed).

**P1, 2026-09-24** (`_pmg_out_stop`, plus `PMG_VACUUM_CRON`/`PMG_VACUUM_BIN` = the pool script's
`/etc/cron.d/<service>-vacuum` and `/usr/local/bin/<service>-vacuum`): step 4 removes the weekly
VACUUM cron BEFORE anything else, then refuses (`_pmg_fail 4`, payouts stay frozen, resume = B → 6
again) while `pgrep -f` finds the vacuum script; with no `pgrep` it warns and carries on. The state
screen shows `weekly vacuum: on/off`; the rollback adds `c) Cron schedules → 2)`. Verified in Part
3's Migrate OUT harness with a fake `pgrep`: scenarios `vacuumcron` (cron removed before the stop,
move completes) and `vacuumrun` (refused before OUT's own stop, cron already gone, frozen) —
**8 of 10 new checks red on the old code, 17/17 after**, including the 7 original scenarios' call
logs byte-identical to Part 3's (archive date normalised).

---

## 9. Durable trend metrics & public chart recorders (2026-07-17, add-ons — NOT VPS-tested)

Two never-pruned hourly rollup tables (kept out of `lib/retention.js`), written by
`HashrateTracker.rollupCompletedHours()` each completed hour, idempotent upserts:

- **`pool_metrics_hourly`** — pool GPS, distinct miners, blocks, earnings, payout **+ new
  `network_hashrate_gps`** (NULL until sampled). The network sample comes from
  `hashrateTracker.networkGpsProvider` (wired in `index.js` to the block monitor's node client;
  `diff × 42 / 60 / 16384`), fetched at most once per completed hour and applied only to the
  just-completed bucket (catch-up buckets after an outage keep NULL — no fake history). Upsert
  keeps an existing sample via `COALESCE` when a re-run passes NULL. **2026-09-20: `worker_count`**
  (additive migration, NULL for hours rolled up before it) — distinct `(grin_address,
  COALESCE(worker_name,'default'))` pairs per hour, the same key `getWorkerBreakdown` groups on.
- **`pool_region_metrics_hourly`** — `(bucket_start, region)` PK: per-region GPS, distinct
  miners, share count, from the `shares.region` stamp. Backs "miners by gateway" trends.

**Endpoints** (public, rate-limited, same `?range=day|week|month|year|all` vocabulary):
- `/api/pool/metrics/history` — now also returns `network_hashrate_gps` per point (null-safe),
  and since 2026-09-20 `worker_count` (null = pre-column hour; a gap, never 0).
- `/api/pool/metrics/history/regions` (new) — `{ series: [{ region, points: [{t, miner_count,
  hashrate_gps}] }] }`, busiest-first.
- **Re-bucketing rule for counts (2026-09-20):** at day-or-coarser buckets both readers take the
  **peak hour** (`MAX`) for `miner_count`/`worker_count`, not the average. `AVG` counted every idle
  hour as zero: the first live day had 2 miners for 3 of 16 completed hours, Month/Year/All rounded
  6/16 to **0** while Day showed 2. Hashrate stays `AVG`, money stays `SUM`. The P-02 panel title
  says which it is showing (`distinct per hour` / `peak hour per day|week|month`), and P-02 now
  draws miners + workers as two lines on one count axis (`renderMultiTrendLine`), the workers line
  omitted entirely until the first hour with a recorded value.

**Frontend**
- Homepage **P-04** now stacks three Chart.js recorders (the hand-rolled 24h strip chart was
  removed; `chart.umd.min.js` + `charts-init.js` are now loaded by `index.html`): pool hashrate
  (24H = fine 5-min series from `/api/pool/hashrate/history`, 7D/30D = rollup), **network
  hashrate as an aligned small-multiple below it** (never dual-axis — network GPS is orders of
  magnitude above pool GPS), and miners online (fixed 30d). Range toggle 24H/7D/30D in the
  panel title (`.chart-range`, reactor.css). **2026-09-21:** the 24H series is gap-filled server-side
  (see §7 — a mining pause used to vanish from the trace); the hourly rollup behind 7D/30D always
  wrote zero-hours, so those ranges were already right. Same day, **P-02b** gateway lamps read
  `2 miners / 5 workers` — `/api/pool/stats/regions` gained `workers` (distinct address+rig pairs,
  the rollup's key), withheld together with `miners` under the k-anonymity floor, plus `totals.workers`.
- **miners-stats P-02b** "Chart recorder — miners by gateway": multi-line per region via new
  `PoolCharts.renderMultiTrendLine()` (union-of-timestamps alignment, gaps NOT interpolated,
  legend for ≥2 series, single y-axis). Colors from `PoolCharts.PALETTE` — 8 fixed slots,
  CVD-validated against the dark panel surface — assigned by region NAME in alphabetical slot
  order (color follows the entity, not the rank). Panel hidden when the only region is
  `default` (single-box) or there's no data.

**Gateway status fix** (same date): `readGatewayStatus()` no longer skips WireGuard peers with
no handshake — a never-handshaked/downed gateway now yields `{handshake: 0}` so
`/api/pool/stats/regions` can mark it `offline` (red). Previously an all-gateways-down pool
returned `{}`, indistinguishable from "wg unavailable", and every dead gateway showed idle
(blue) forever.

**Public copy** (index.html): P-05 patch-note folded into the miner-setup guide (password
guidance now tells miners to pick a real private password — a future release may verify it);
P-08 vardiff line removed (no vardiff exists); payout lines now describe the miner-initiated
Tor/slatepack rails with 6h→48h retry back-off and refund-on-failure; P-03 mimic says
`SLATEPACK ▸ ON REQUEST`. Note: the stratum password is currently **not read or stored**
anywhere (`handleLogin` parses only `login`). *(Superseded later the same day — §10 makes the
password an ownership proof.)*

## 10. Ownership gate v2 + manual-withdrawal simplification (2026-07-17, add-ons — NOT VPS-tested)

> The last-2 windows described in §10–§10.1 were replaced on 2026-09-22 by a proof SET of up to
> 10 per kind with a per-address salt — §10.4 and design §17. This section is left as the 2026-07-17 record.

Operator decisions (same-day discussion): proof = IP **or** password; keep last-2 windows but
hash at rest; gate **all** money actions; retire the per-account payout threshold.

**Gate (lib/owner-proof.js, rewritten):** `verifyOwnerProof(db, addr, submitted)` takes ONE
field — if it parses as an IP (v4/v6, canonicalised) it's checked against the last-2 IP
window; a usable password is checked against the last-2 password-hash window. All proofs
stored as salted scrypt `v1$salt$hash` (never plaintext); legacy plaintext IPs upgraded by a
background `migrateOwnerProofHashes(db)` at startup (index.js calls it after scheduler start).
Trivial passwords (`x`, `123`, defaults, `d=…`, <4 chars) never capture/verify. Fail throttle
unchanged (8/10 min → 5 min lockout). `canonicalizeIp` gives IPv6 one stable form (zone/
brackets/`::ffff:`/`::`-expansion/v4-tails).

**Capture (stratum):** `handleLogin` now also reads `params.pass` → kept on the in-memory
session only; on a session's **first accepted share** `handleSubmit` calls
`minerManager.recordOwnerEvidence(addr, ip, pass)` (async fire-and-forget) which shifts the
last-2 windows for both proofs. Schema: `miner_accounts` + `last_pass_hash`/`prev_pass_hash`
(migrateMinerAccounts).

**Routes (index.js):** `POST /api/account/:addr/withdraw` (tor AND slatepack),
`…/:id/finalize`, `…/:id/cancel` all verify `req.body.proof` (legacy `ip_proof` accepted) —
rationale: an ungated Tor trigger let anyone force payouts for leaderboard addresses (pool-paid
fees, output consumption, forced timing) and an open cancel was a nuisance vector.
`POST /api/account/:addr/min-payout` **removed**; account GET no longer returns
`min_payout`/`effective_min_payout` and adds `has_recorded_pass` next to `has_recorded_ip`.
Scheduler enforces only pool-wide `config.min_withdrawal` (min_payout column now dead).

**Account page (account-settings.html):** P-04 is one column — single ownership-proof input
(hint links https://tools.grin.money/tools/my-ip/ for IPv4/IPv6 lookup), shared amount field
(blank = full balance, label shows the pool minimum), Tor/slatepack radio. Threshold UI
removed; cancel now sends the proof; friendly `PROOF_REASONS` mapping for gate errors; demo
dataset updated. Sidebar shows the pool minimum.

**Verified locally:** `node --check` on index.js + 5 libs + the extracted inline script;
owner-proof smoke test (canonicalisation v4/v6, capture/no-op/rotation, IP+password verify,
trivial-password rejection, legacy plaintext verify) — all pass. Deploy needs a backend
restart (column migration + background hash migration run automatically).

### 10.1 Same-day follow-up (2026-07-17 later, add-ons — NOT VPS-tested)

Operator decisions after a second discussion round:

- **Public cancel REMOVED** (route + P-04 button + `cancelPending`). Both parked states
  self-recover — Tor `markFailed()` auto-reverses after max retries, slatepack auto-refunds
  via TTL expiry — so cancel was pure abuse surface: a Grin send that *looks* failed may have
  actually posted, and reversing the lock then = double-pay. Admin support cases use the
  existing step-up `POST /api/admin/withdrawals/:id/cancel` (payments page);
  `scheduler.cancelWithdrawal()` kept for admin tooling only. Known residual (documented, not
  built): the automatic retry/reversal paths carry the same theoretical exposure — proper fix
  is recording slate_id on Tor sends + checking wallet tx state (`retrieve_txs`) before any
  retry/reversal.
- **Explicit amount + min/max chips**: blank-=-full-balance retired on the page (API still
  accepts `amount:null`). The amount label has clickable `min <pool-min>` / `max <balance>`
  chips that autofill; `amountValue(msgEl)` now rejects blank/non-positive with a hint.
- **Blocklist additions-only**: new `access.extra_banned_passwords` (pool_config, JSON array;
  validator accepts newline/comma lists and normalises to deduped lowercase, cap 500).
  `isUsablePassword(pass, db)` merges it (60 s cache) ON TOP of the hardcoded seed — the seed
  and structural rules can never be removed via admin. Editable in settings-access.html
  (textarea, one per line; populate special-case in settings-common.js). Because verify
  re-checks the submitted value, a newly added entry stops working as proof immediately.
- **Payout rail status chip**: account summary now returns `payouts_frozen`
  (`scheduler.isFrozen()`, boolean only — the freeze reason stays admin-side); P-04 title
  shows "payouts active/paused" chip and the Tor button disables while frozen.
- **Goblin nickname payouts over Nostr**: design only → `script07_design.md` §15 (registered
  destination + 48 h cooldown + npub TOFU pin; bridge sketch reusing the slatepack state
  machine). Not scheduled.

Verified: `node --check` ×5 + re-extracted inline script; blocklist smoke test (seed + extra
entries, case-insensitivity, corrupt-JSON fail-open) and validator normalisation tests pass.

**Round 3 (same day):** cross-rail payout exclusivity + cooldown (audit §E.2 has the full
security rationale). Shared `PENDING_SQL` in withdrawal-scheduler.js closes the hole where a
pending slatepack didn't block a Tor create (and fixes the same 3-status list in the admin
miner-detail pending view). New `_assertNoRecentReversal()` gate in both create paths:
after any withdrawal reversal (Tor failure, slatepack expiry/creation failure, admin cancel)
the address waits `payout.withdrawal_cooldown_minutes` (default 30, 0 disables) before
requesting another payout on any rail. Plumbed through pool-settings defaults/validator/
applyToConfig, config.js default, and a field on admin settings-payout.html (applied at
backend restart, like min_withdrawal); account-page note mentions the cooldown. The designed
Nostr rail (design §15) inherits both gates automatically since it parks in
`slatepack_pending`. Verified: `node --check` ×4 + 12-case stub-db smoke test (pending gate
cross-rail, cooldown default/custom/disabled, validator bounds) all pass.

### 10.2 Goblin/Nostr payout rail BUILT (2026-07-18, add-ons — NOT VPS-tested)

Full implementation of design §15 (which now carries a §15.5 "what shipped" note). A miner
registers a Goblin username on the account page and is paid over a Nostr DM — no Tor listener.
**OFF by default** (`nostr_payouts_enabled`); needs `npm install` (nostr-tools + ws) and a
backend restart. Third-party rail (pays a username, not the address's own wallet), so it
layers a registered destination + ≥48 h cooldown + TOFU npub re-pin on top of the ownership
gate — see security_audit §E.3 for the threat model.

Build shape (bottom-up):
- `lib/nostr-payout.js` — the bridge. nostr-tools + ws lazy-required inside `start()` (pool
  boots without them when the feature is off / not yet installed). All nostr-tools calls are
  confined to a "wire" section so a future API drift is a localized fix. Does NOT touch
  balances — transport only. Resolves usernames (NIP-05, domain-allowlisted), publishes the
  NIP-17 gift-wrapped slatepack, and runs a persistent subscription that routes an incoming S2
  back to the scheduler. Dedup via a `nostr_seen_events` table. Pool identity key persisted to
  a `.nostr_payout_key` file (transport-only; can't sign slates).
- `lib/withdrawal-scheduler.js` — `createNostrWithdrawal` (mirrors the slatepack rail: same
  CAS lock, `PENDING_SQL` cross-rail one-pending, freeze + failed-payout-cooldown gates, TTL
  refund; S1 is **plain armor** `recipients:[]`; publishes via the bridge, reverses the lock on
  any wallet/relay failure) and `finalizeNostrWithdrawal` (called by the bridge on an S2:
  re-checks sender==registered npub + binds slate.id, then finalize+post+confirm; errors leave
  the row pending for resend/TTL). `nostrBridge` injected post-construction to avoid a cycle.
- `index.js` — constructs+starts the bridge at boot inside a try/catch (missing package →
  warn + disable, never crash); wires the response handler; adds
  `POST`/`DELETE /api/account/:addr/nostr-destination` (ownership-gated, rate-limited) and a
  `method:'nostr'` branch in the withdraw route that enforces registered + cooled-down +
  TOFU-verified destination before calling the scheduler; account summary gains
  `nostr_payouts_enabled` + a `nostr_destination` state object (username + active_at, npub
  never exposed).
- Config: `lib/config.js` defaults + `lib/pool-settings.js` (defaults/validators/applyToConfig)
  for `nostr_payouts_enabled`, `nostr_relays`, `nostr_nip05_domains`,
  `nostr_destination_cooldown_hours`. Admin fields on `settings-payout.html` (+ the
  JSON-array↔newline populate special-case in `settings-common.js`). `package.json` gains
  `nostr-tools` + `ws`.
- Frontend `account-settings.html` P-04: a "Goblin (Nostr)" payout option (shown only when the
  pool enabled the rail) with a register/replace/remove destination form and a send button that
  unlocks only once the destination is past its cooldown.

Verified: `node --check` on all edited JS + the extracted account-page inline script; a
23-case stub smoke test (slatepack extraction one/none/two/oversized, relay-floor forcing +
domain allowlist parsing, all four validators, and the scheduler's createNostrWithdrawal
guards + lock/reverse-on-publish-failure + finalize sender-mismatch rejection) — all pass.
**NOT VPS-tested**: the live Nostr transport (nip59 wrap/unwrap signatures, SimplePool relay
I/O, real goblin AutoReceive round-trip) needs an E2E run against `relay.floonet.dev` with a
real Goblin wallet — do a testnet / tiny-amount pilot first.

### 10.3 Account online state is per RIG, not per address (2026-09-21, add-ons — NOT VPS-tested)

First multi-rig test: one of two workers dropped and the account page read **Status: Offline** /
**Miner offline** while the other rig kept submitting. Root cause in `lib/miners.js`:
`closeSession()` wrote `miner_accounts.is_online = 0` on EVERY session close — the flag is
per address, sessions are per rig — and nothing but the next login ever set it back. The
admin miner lists read the same column, so they showed it too.

- **Backend:** `closeSession` (and so `pruneInactiveSessions`) now drops the flag only when it
  closed the address's LAST live session (`getSessionsByMiner().length === 0`).
- **Account page:** P-05 Status and the header lamp are now one three-state readout,
  `renderOnlineState(online, total)`, driven by the same per-worker rows as the P-03 LEDs and the
  "Workers online" pill: all seen-in-24h rigs online → `Online ⛏` / `Miner online`; none →
  `Offline` / `Miner offline` (warn lamp); some → `Partial — x / y online` /
  `x of y workers online` (warn lamp). First paint uses the account flag, then the worker fetch
  refines it, so the summary can no longer disagree with the table under it. Note the two feeds
  differ on purpose: the per-rig `online` needs an accepted share (audit §J6-9), the account
  flag flips at login — a rig that just connected reads Offline until its first share lands.
- **Worker name is now what the miner typed:** `<address>.donate10` logged in as worker
  **default** — `validateUsername` stripped the `donateN` token from the label, and with nothing
  left the stand-in name applied. Nothing on screen said why, so it read as a bug. Nothing
  depended on the strip (the % travels as `parsed.donation_percent` → session → applied on the
  first accepted share; the name only groups shares), so the token is now READ and never cut:
  `.donate10` → worker `donate10`, `.rig01-donate10` → `rig01-donate10`. The literal name is
  also the one place a rig's donation is visible, which is what audit §J3-5 asked for. A name
  over the visible cap that carries a token is cut on its label part so the token stays on screen
  (the cap was 25 here, so `rig-name-that-is-long-enough-donate100` → `rig-name-that-i-donate100`,
  still 100 %; it is 32 since the Part 1 note below, which also strips the cut's trailing separator).
  Public copy on `donate.html` updated; `scripts/test-stratum-guards.js` +5 cases (59/59).

Verified locally: `node --check` on `miners.js`, `stratum-protocol.js` and the extracted inline
script; stub-DB run of two sessions on one address (close one → flag untouched, close last → 0;
prune → 0); stub-DOM run of `renderOnlineState` for 1/1, 0/1, 2/2, 1/3, 0/4; guard suite 59/59.

**Donor wall (`/api/pool/donors`, `donate.html` D-03) — same day.** Three findings from the
live-miner test, all fixed:
- `totals` were summed **after** `LIMIT 100`, so "Donors" / "Donated all-time" undercounted from
  the 101st donor on. The LIMIT moved out of the SQL (the `ORDER BY` already forces the full
  aggregate) and the cards are sliced in JS; `totals` now cover every donor.
- `active_donors` counted cards with a debit, and a donation is debited only when a block
  **matures** — a young pool reported "0 currently donating" for days with tags set. It now
  counts `miner_incentives.donation_percent > 0` directly, and the empty wall says "N miners have
  a donate tag set — the first slice is taken when the pool's next block matures".
- Both `current_percent` and `active_donors` are gated on `donationsActive()` (the predicate
  `/api/account/:addr` already used), so a pool with donations switched off shows every card
  `paused` rather than advertising cuts it is not taking.
- Copy: D-01 gained the "raise = go through `donate0` first" row (§J6-7 only lowers directly),
  and the account page's donation-row tooltip says the same. No age-out: past donors stay on
  the wall with `paused` — deliberate, a thank-you is not revoked when the giving stops.
  *(Superseded the same day by Part 4 below: the wall is a windowed league now, and a donor with
  nothing in the window moves to the capped "past donors" strip — still never deleted.)*
Verified with an in-memory stub of the three ledger tables (102 donors → 100 cards, count 102,
Σ exact; 5 live tags incl. 2 with no debit; donations off → 0 active, all badges 0).

**Part 1 (login grammar) — design §16, 2026-09-21, NOT VPS-tested.** The first of six
sessions for the donor names + league (design §16; per-session plan kept outside the repo).
`validateUsername` in `lib/stratum-protocol.js` only:
- **Worker part case-folded** — everything after the first `.` has ASCII `A-Z` folded before the
  grammar runs, so `MyBrand-donate10` logs in as worker `mybrand-donate10` at 10 % (it was refused
  at login). The address is never folded: `GRIN1…` and any mixed-case address still return null.
  ASCII-only on purpose — `toLowerCase()` maps U+212A KELVIN SIGN into the charset as `k`.
- **Limits** `MAX_WORKER_NAME_LEN` 25 → **32**, `MAX_WORKER_RAW_LEN` 40 → **48** (a 27-char brand
  clipped to `northern-hashwo-donate10`). The cut rule is unchanged — cut the label, keep the token,
  so ≥ 22 label chars survive beside `-donate100` — but the cut label now loses any trailing `-`/`_`:
  `rig-name-that-is-long-enough-donate100` → `rig-name-that-is-long-donate100`, never
  `…long--donate100`. An uncut label is byte-faithful (a typed `acme--donate10` keeps `acme-`).
- **Fourth return field `donor_label`** — `null` with no live token (a plain name, including an
  out-of-range `donate101`); `''` when the token is the whole name (`donate10` → masked address on
  the wall); else the label part **after** the cut, lowercase, which Part 2 stores as the donor name.
  The existing three fields are unchanged and stay first. `stratum-server.js` reads the result by
  field name, so nothing else moved.
- **Copy stating the old limit** fixed in place: the login error line (`stratum-server.js`, now
  "auto-shortens to 32 chars; keep it within 48"), the getting-started step on `index.html` (also
  no longer says "lowercase" as a requirement — it is applied), and five statements in the
  security audit (§J6-1, §J6-9, §J6-13, Handoffs). `donate.html` D-01 is Part 4's.
- **Tests** `scripts/test-stratum-guards.js` 61 → **71/71**: the cut expectation updated; +10 —
  uppercase worker folds, uppercase / mixed-case address refused (with and without a worker; the
  case-fold must not leak into the address), 32-char name kept whole (plain and 22 + token),
  33-char cut (both), 48 accepted / 49 refused, `_` and multi-separator strip, the three
  `donor_label` values, and the return shape (exactly four keys, existing three first).

Verified locally: `node --check` on `stratum-protocol.js`, `stratum-server.js` and the test
script; guard suite 71/71; no server started, no file left in the repo.

**Part 2 (storage + capture + the miner's own view) — design §16.3/§16.4/§16.9, 2026-09-21,
NOT VPS-tested.** Names are now captured and stored, and shown ONLY to their owner on the
account page — nothing public reads them until Part 3's moderation exists (plan ordering, not a
preference).
- **Columns** — the six `donor_*` columns from §16.3 on `miner_incentives`, in the CREATE for a
  fresh DB and via `migrateMinerIncentives()` (same add-column-if-missing pattern as
  `miner_accounts`) for an existing one; idempotent, runs on every boot.
- **`lib/donor-names.js` (new)** — the whole name model, `db` passed in, no dependency on
  `index.js` or `pool-settings.js` (the latter imports the starter list from it): `normalise`
  (lowercase, strip `-`/`_`, leet `0→o 1→i 3→e 4→a 5→s 7→t`), fixed `RESERVED` (the ten §16.4
  words + the pool name, which is applied only when it normalises to ≥ 3 chars — a two-letter
  pool name would censor everyone), `STARTER_BLOCKLIST` (51 entries, the DEFAULT of the setting),
  `matchBlocklist` (reserved first, then the operator list split on newlines — never a RegExp;
  returns the entry as typed for the admin badge), `captureDonorName` (§16.4 exactly: `''` clears,
  `admin` sticky, `allow` override, else `auto` + word or NULL; `donor_name_set_at` on every call;
  a clear also drops an `auto` verdict since it was about the name that is gone, while `admin` /
  `allow` survive as per-address decisions), `rescanAll` (walks `donor_name IS NOT NULL` rows that
  are NULL/`auto` — bounded by names, never shares; returns `scanned`, `censored` = rows in `auto`
  AFTER the scan, `cleared` = `auto` rows the new list no longer matches; re-stamps `censor_at`
  only on a change), `displayState` (the ONE function both the account API and Part 4's wall
  call — `shown | masked | censored | expired`, `name` null for everything but `shown` unless
  censored + `marker`), and `donorSettings` — the bounded reader every consumer goes through.
- **Two deltas from §16 worth knowing.** (1) Expiry counts from the LATER of the last donation
  debit and the capture itself, in calendar months (UTC): a name just set through the ceremony is
  not instantly "expired" while its first debit is still a block away, and a returning donor who
  re-runs the ceremony is fresh again. (2) Censor outranks expiry — a censored name that also
  aged out still reports `censored` (and the marker, if chosen).
- **Settings** — six keys on the `incentives` section with write-side validators (list cleaned to
  one trimmed entry per line, ≤ 64 KB / 4000 entries; display a closed enum; ints/percent/cap
  bounded) AND `donorSettings()` re-bounding every value on read (a hand-edited row, a blank or
  `"abc"` → the default, never NaN). No new booleans. `donation_address` and
  `allow_miner_donations` stay where they are; Part 3 moves them.
- **Capture site** — `stratum-server.js` parks `donor_label` on the session at login beside the
  percent; the donation-apply block moved verbatim into `_applyParkedDonation(session)` (one
  call site, same PROOF_MIN_SHARES gate at it) so the test can drive the real branch; the name
  write is `wrote && current === 0 && percent > 0` and nothing else — a LOWER, a same-value
  resend, a refused raise, a `donate0`, or a set that `setDonation` refused (donations off) never
  reach it. `_captureDonorName` reads the list + pool name fresh per capture (once per ceremony,
  never per share) and logs one line: masked address, name, censor state — never the password
  or IP.
- **`lib/donor-ledger.js` (new)** — `lastDonatedAt(db, address, H)`, the single-address form of
  the composite rollup + raw read `/api/pool/donors` uses. One home for the ledger SQL so Part 3/4
  extend it rather than fork it; no column was added for the date.
- **`/api/account/:addr`** gains `donor_name` + `donor_name_state`, behind the same
  `donationsActive()` gate as `donation_percent` (both null on a dormant pool), through
  `displayState`. `API_DOC_META` row updated. The account page's donation row now also stays
  visible for a PAUSED donor who has a name (`paused (0%)`), with a second line: *Donor name:
  acme* / *hidden by the pool — contact the operator if this is a mistake* / *expired —
  reconnect with your tag to refresh it*; `textContent`, never innerHTML; tooltip explains the
  rename ceremony. `masked` and null print nothing extra.
- **Tests** `scripts/test-donor-names.js` (new, in-memory copy of the REAL schema via
  `initDb(':memory:')`, in `npm run test:unit`): **100/100** — migration twice, normalise/leet,
  reserved (incl. pool name and its 3-char floor), list (CRLF, order, regex-special text never
  throws), the `classic ⊃ ass` false positive documented as EXPECTED, capture in every censor
  state, `''` clear semantics, rescan counts + idempotence + empty list, displayState for all four
  states × both display modes + the exact calendar boundary, bounded readers with junk input,
  validators + a store round trip, the composite ledger read across the horizon, and the stratum
  gate with a stub incentives manager (eight arms incl. the full ceremony) plus the real capture
  path with its log line. Guard suite unchanged at 71/71; admin-panel 41, public-leakage 58,
  admin-guards 65, money-path 32 all green; `check-syntax` 64 files + 29 inline blocks.

Verified locally, one-shot only (no server): `node --check` on every touched file, the suites
above, and the account page's donation-row branch driven against a stub DOM for all six states.
`git status --short` shows the three new files and nothing else untracked.

**Part 3 (admin: routes, audit, rescan, `donors.html`, settings move, dashboard count) — design
§16.5/§16.8, 2026-09-21, NOT VPS-tested.** The operator's moderation surface. Nothing public
changed: `/api/pool/donors` and `donate.html` are untouched (Part 4), and the guard suite now
pins that the public route still masks and emits no censor word/by.
- **`GET /api/admin/donors` (secureAdmin)** — one row per address that has a ledger debit, a
  live tag, **or a stored name** (a widening of §16.8's two: a miner who ran the ceremony and
  paused before the first matured block has a name on file and no debit, and moderation that
  starts after publication is the review gate §16.1 #3 rejected). FULL addresses. Per row:
  name + the six `donor_*` columns, `current_percent` (0 when donations are switched off — the
  same gate as the wall), `lifetime_donated`, `in_window_donated`, `active_months`, first/last,
  `donation_count`, `multiplier`, `score`, `rank` (league order; null with nothing in the window),
  `is_new` (captured ≤ 7 d), `renamed_while_censored` (`admin` and `set_at > censor_at`), and
  `workers` from `getWorkersForAccount(addr, 1440)` — `{name, online, tagged}`, `tagged` via
  the new `parseDonateToken()` export of `lib/stratum-protocol.js` (the login regex became a
  named constant both use; `validateUsername` is byte-for-byte the same, guard suite 71/71).
  Envelope: `count`, `window_days`, `donations_active`, `new_names_7d`, `now`; `?limit` ≤ 500.
  Cost: ONE composite ledger scan (the same UNION `/api/pool/donors` has always run) + a small
  `miner_incentives` read + per-returned-row indexed worker lookups on a table pruned to ~31 h.
- **`lib/donor-ledger.js`** grew the per-address aggregate `donorLedger(db, {H, windowDays,
  now})` (lifetime, in-window, first/last, count, **active months = `COUNT(DISTINCT
  strftime('%Y-%m', t))`** over rollup + raw) and the §16.6 helpers `loyaltyMultiplier`,
  `donorScore`, `leagueOrder` — Part 4's league imports these, so the admin list and the wall
  cannot rank differently. **Window boundary, stated once in the lib:** a rolled day is one row
  at its UTC midnight and is in the window WHOLE when that midnight is ≥ the cutoff (a 23:59
  debit on a rolled day counts by its day); raw rows compare at second precision.
- **`POST /api/admin/donors/:addr/censor` and `/uncensor` (freshAdmin)** — `:addr` through
  `GRIN_ADDR_RE` (400), then `lib/donor-names.js adminCensor()`, which is the state machine, the
  write and the `admin_audit_log` row (`donor_censor` / `donor_uncensor`, target_type `donor`,
  details `{name, previous}`, ip) in ONE transaction — fail-closed like `updateSection`. 404
  unknown address, 409 already in that state. Table: NULL/auto/allow → censor → `admin`;
  NULL/auto/admin → uncensor → `allow` (never NULL — NULL would re-arm the auto-list). A censor
  on an address with no name yet is allowed (pre-emptive, sticky); an un-censor from NULL is
  allowed (pre-emptive whitelist). The word is cleared on either — it described an auto verdict.
- **Rescan hook** in `POST /api/admin/settings/:section`: reads the list + pool name BEFORE the
  write and, when either CHANGED (not merely present — the harvester posts every key), runs
  `rescanAll` and returns `rescan: {scanned, censored, cleared}` on the response; a rescan
  failure is reported in that field and never fails a save that already landed. Renaming the
  pool triggers it too, because the pool name is a reserved word (§16.4 #2).
- **Dashboard** `new_donor_names_7d` (`countNewNames`: `donor_name IS NOT NULL AND set_at ≥
  now − 7 d`, so a cleared name is not "new") on `/api/admin/dashboard` → a sixth Overview tile
  linking to Donors; **`GET /api/admin/donors/summary`** (one COUNT) feeds the nav badge that
  `admin-shell.js decorateDonorBadge()` paints on the Donors row on every page load — painted
  only for a positive number, so a 429 body can never render "undefined". Pill ink is
  `var(--btn-text)`, the admin bundle's ink-on-accent token (`--bg` does not exist there).
- **`admin-panel/donors.html` (new)** — NAV child of Dashboard directly after Miners. Same
  shell as `miners.html` (auth gate, AdminTable with search + paging, `setRows` keeping page +
  query on the 60 s timer, `reset` only from the state select: all / named / censored / new).
  Columns per §16.8 with medals for the top 3, the state badges (`ok` · `auto: "word"` ·
  `admin-censored` · `allowed` · `NEW` · `renamed while censored`), workers as LED + name with
  the tagged rig marked 🏷 (6 shown, "+N more"), and `.btn-icon` row actions (🚫 censor / ✅
  allow, shown per state) passing the address via `data-addr`. Every name/word/worker name goes
  through `escHtml`. A non-2xx body from `API.get` renders as an ERROR row, never as "no
  donors". **Donation settings** on the same page: `allow_miner_donations` + `donation_address`
  (MOVED here — `settings-incentives.html` keeps one line linking to Donors; the moved keys exist
  on exactly one page, pinned by test), then the six donor keys with helpers, the list as a
  monospace textarea. The form is PAGE-LOCAL, not `settings-common.js`: `saveSection()` discards
  the response body and the one thing this form must show is the rescan counts. Its harvester
  follows the same three rules (bind by id; `settings-skip`; blank scalars dropped unless
  `settings-allow-empty` — `donation_address` carries it so "leave blank" persists). No merge
  step was needed: `updateSection()` upserts only the keys it is sent, so the partial form and
  the Incentives page never clobber each other. Both flash targets hide INLINE (the 2026-09-19
  rule). Writes go through `adminFetch` — `Auth.fetch` would surface a freshAdmin challenge with
  no way to complete it; a plain session on this page is the normal case.
- **Tests** — `test-donor-names.js` 100 → **148/148** (+ token parser, ledger aggregate with the
  exact day-edge in/out, window 0, junk window, below-horizon raw invisible, score/multiplier/cap
  incl. NaN/Infinity in, league order, the full censor table with audit rows, fail-closed
  rollback via a bad admin FK, new-names count at the 7-day edge); `test-admin-panel.js` 41 →
  **71/71** (page exists, NAV position, id sweep against the LIVE `PoolSettings.defaults`, moved
  keys on exactly one page, inline-hidden flash targets, `this.dataset` row buttons, adminFetch
  not Auth.read, error-vs-empty, escaping, rescan flash, the Overview tile; the sweep was
  negative-controlled with a stray hidden id); `test-admin-guards.js` 65 → **79/79** (guard tier
  per route read from the declaration — control: ban=fresh, miners=secure — address gate,
  delegation to `adminCensor`, 404/409, the rescan hook's before/after shape, public route
  unchanged, dashboard field). All 14 suites green; `npm test` exit 0.
- **A pre-existing gate bug fixed on the way — `scripts/check-syntax.js`.** Its `type=` sniff ran
  over the WHOLE `<script>` match, body included, so any inline block whose row template contains
  `type="button"` read as `type=button` → "not JavaScript" → skipped. `donors.html`, `miners.html`
  and the admin `index.html` were never syntax-checked, and a deliberately broken `donors.html`
  passed `npm run check-syntax` with "Syntax OK". Now sniffs the opening tag's attributes only:
  29 → **32** inline blocks; the negative control fails with the file named.

Verified locally, one-shot only (no server): `node --check` on every touched file; the suites
above; the page's inline script driven through a stub DOM (28 checks: hostile names/words/worker
names escaped, actions per state, filters, timer vs reset, 429-as-error, harvester rules, save +
rescan flash, refusal reasons, populate); the real `GET /api/admin/donors`, censor/uncensor,
dashboard and settings-save handlers extracted from `index.js` and run against the in-memory
schema (21 checks incl. the rescan hook firing on a list change, NOT on an unchanged list, on an
empty list, and on a pool rename). `git status --short` shows `donors.html` + Part 2's three
files and nothing else untracked.

**Part 4 (public: `/api/pool/donors` v2, D-03 league + past strip, copy, api-docs, leakage
tests) — design §16.6/§16.7/§16.9, 2026-09-21, NOT VPS-tested.** The part that makes names
visible. The admin page and the capture rule are untouched.
- **`lib/donor-ledger.js donorWall(db, {ds, now, H, active, rigsOnline, mask})`** builds the
  whole response — in the lib, not the route, because `index.js` starts a server on require and
  a route can only ever be read as text; `scripts/test-donor-league.js` runs the builder against
  the in-memory schema. Shape: `{ league: [card…], past: { donors: [card…], more }, totals,
  ranking: { window_days, loyalty_percent_per_month, loyalty_cap, name_expiry_months },
  censored_display }`. Card: `rank` (1..N, null on past) · `name` · `name_state` · `address`
  (masked) · `in_window_donated` · `total_donated` · `active_months` · `multiplier` · `score` ·
  `current_percent` · `first/last_donated_at` · `donation_count` · `rigs_online`. League =
  in-window > 0, `leagueOrder`, LIMIT 100; past = nothing in the window, most recent last
  donation first (ties: lifetime DESC, address ASC — rolled days tie by the day), LIMIT 20 +
  `more`; the two are disjoint by construction. `totals` stay lifetime over every donor; a
  donor beyond the 100th league place is on neither list but is counted (design as written).
  **The mask is a REQUIRED argument and the lib throws without one** — a wall with no mask is
  §J11-1, and `past` is exactly the second array a route would forget. Names through the SAME
  `displayState` the account API uses; no card key starts with `donor_`. Settings through
  `donorSettings()` (bounded), with a fallback to defaults when no `ds` is passed, so a blank
  or `"Infinity"` setting can never reach a multiplier (memory
  `reference_money_number_boundary_traps`). Cost: the one composite ledger scan the route has
  always run, one COUNT for `active_donors`, one IN-list read of `miner_incentives` for the
  ≤ 120 cards shown.
- **Route** — thin: reads `donationsActive()`, `donorSettings`, builds `rigs_online` in ONE
  pass over `minerManager.getActiveSessions()` (MINING sessions only, `acceptedShares > 0`,
  §J6-9 — a login is unauthenticated, so without the share bar anyone could put rigs on
  someone else's card; distinct worker names, never a shares query per card) and passes
  `mask: (a) => maskAddr(a)`. Same `public` bucket; still `raw` shape.
- **`donate.html`** — D-01: `grin1…address.donate10` now says the wall shows the masked
  address; the `rig01-donate5` row became `grin1…address.yourbrandname-donate10` with the
  donor-name sentence (lowercase, up to 32 characters; plain `donate10` = masked address); the
  panel note gained "to change your donor name, use the same ceremony as a raise" and that a
  plain `donate10` at that step removes the name. D-03 is "Donor league": a ranking sentence
  (`#donor-ranking`) rewritten from `ranking` — "in the last N days" / "all-time" for 0 — with
  a window-agnostic static fallback so a failed fetch never states a wrong number; cards per
  §16.7 (medal or `#N`, display name, GRIN in window with "in window" only when a window is
  set, lifetime only when it differs, `×1.4 loyalty · 4 months`, `donating N%` / `paused`,
  `since <day> · N rigs online`); a **past-donors strip** (`#donor-past`: name/masked +
  lifetime + last day, then "and N more past donors"); "Names are chosen by the donors and are
  not verified by the pool." at the foot of the panel; "(all times UTC)" stays once in the
  deck-head. Three empty states: no donors (tags-set message kept), donors but an empty
  window ("NO DONATIONS IN THE RANKING WINDOW YET — past donors below"), and unavailable.
  **Every name goes through `escHtml`** — the marker `<censored-donor>` contains angle
  brackets and must display literally. The read stays the page's own 2xx-only `fetch`
  (`r.ok ? r.json() : null`, the `Auth.read` contract — `auth.js` is not loaded on this page
  and `Auth.fetch` is never used). Names `word-break: break-all`; the first line of a card
  clears the absolute rank badge (`padding-right: 44px`).
- **api-docs** — the `GET /api/pool/donors` meta row rewritten for the v2 shape (league/past/
  totals/ranking, score formula, opt-in lowercase name, masked addresses, the marker only under
  `marker`, window edge). §1b drift check: 49 routes / 49 meta / 0 / 0; row hand-read against
  `donorWall()`.
- **Tests** — `scripts/test-donor-league.js` (new, in-memory, **68/68**): mask required; 102
  donors → league 100, totals 102, Σ exact, ranks 1..100; window 365 drops a 400-day donor to
  past with lifetime intact and window 0 brings it back with in_window == lifetime; the exact
  day-edge in/out; active months across rollup + raw (3), multiplier ×1.3, cap ×3 at 30 months
  and a lower cap honoured, 0 % loyalty; tie order (months DESC, first ASC); past cap 20 + more
  5, order, same-day tie-break; league/past disjoint; empty league + past; all name states in
  both display modes, expiry incl. 0 = never; leakage sweep (no `donor_censor*` /
  `donor_name_set_at` / `grin_address` key, no full address string, no censor word, no marker
  under masked); the switch gating; `rigs_online` from Map/function, NaN → 0, never ranked;
  junk/blank/Infinity settings → defaults and finite scores, JSON round trip with no
  null-from-Infinity. `scripts/test-public-leakage.js` 59 → **77/77** with §9: the route
  delegates with the mask and reads no donor column itself; the lib's card builder has no
  `donor_` key and masks via `opts.mask` only; neither `index.js` (outside the api-docs row) nor
  the ledger lib spells the marker — `displayState` is the one emitter (exactly 3 mentions in
  `donor-names.js`); `/api/account/:addr` selects three donor columns and emits two fields;
  live `displayState` checks (masked → null, marker → the string, unknown value → masked, marker
  never touches shown/masked/expired, never a `donor_` key). `test-admin-guards.js`'s Part 3 pin
  on the old inline `r.address = maskAddr(r.address)` updated to the v2 form (79/79); added to
  `npm run test:unit`. 15 suites green; `check-syntax.js` 65 files + 32 inline blocks.
- **Delta vs §16:** none in substance. Two things the design left implicit are now stated:
  the past strip's tie-break, and that a league overflow (>100 in the window) is counted in
  `totals` but shown on neither list.

Verified locally, one-shot only: `node --check` on every touched file; the suites above; the
page's inline script `vm.Script`-parsed; the **390 px iframe probe** (a throwaway Node static
server on 127.0.0.1 with stubbed `/api/*`, Chrome headless `--dump-dom`, killed in-session) on
three fixtures — full league with a 31- and a 32-char name, the marker, a 100 % badge, and a
past strip with `more` 14; past-only with an all-time window; no donors with 2 tags set —
`docWidth` 375 (= 390 − scrollbar), **0 elements past the right edge**, every state's copy
rendered as designed. `git status --short` shows `test-donor-league.js` and the Part 2/3 files
untracked and nothing else.

**Part 5 (independent review of Parts 1–4) — design §16 + §16.10, 2026-09-21, NOT VPS-tested.**
A separate cold session read the working-tree diff against §16 in the plan's nine-question order
(stranger write trace, public leakage field list, censor state table, a hand-recomputed card,
type traps, DB cost by `EXPLAIN QUERY PLAN`, panel rules, public-page rules, docs honesty). The
questions, their answers and the deltas table are **design §16.12** — the durable record; this
note is what changed in the tree.
- **Fix A (Medium) — `lib/donor-names.js rescanAll`** parsed the operator's list once per
  NAME: `matchBlocklist(name, listText, …)` re-ran `parseList` (normalising every entry) on
  every row. Measured 300 names × the 4000-entry validator ceiling = **1048 ms** per list save
  on the synchronous connection the stratum server shares — a one-second share-intake stall,
  admin-triggered. The matcher is now two layers: `matchEntries(name, entries, poolEntry)` over a
  pre-parsed list, with `matchBlocklist` the one-name convenience over it; the walk parses once
  (**16 ms**). `poolNameEntry` and `matchEntries` are exported for the test.
- **Fix B (Low) — `captureDonorName`**: a separators-only label (`--donate10` arrives as `-`,
  `_-_-donate10` as `_-_` — inside the grammar, so Part 1 hands it over as typed) passed
  `LABEL_RE`, normalised to `''`, matched nothing and was stored and shown as the name `-`. It is
  now no label (clears, like `''`); `-a-` and a lone leet digit are still names.
- **Tests** `scripts/test-donor-names.js` 148 → **156/156**: four label cases for B; for A an
  equivalence check (`matchEntries(parsed) ≡ matchBlocklist(text)` over six names incl. a
  reserved word, the pool name and a list entry), a source pin that `rescanAll` calls
  `parseList` exactly once above its row loop and the loop uses `matchEntries`, the 4000-entry
  list giving the same verdicts, and a 2 s ceiling on that walk. Every other suite unchanged; all
  16 (15 scripts + `check-syntax`) green after the fixes.
- **Docs** — design §16 heading and file header no longer say "NOT built" / "Parts 3–6 design
  only"; §16.11 Part 5 row; §16.12 added; security audit header + Status roll-up now name Parts
  2–4's new surface and that §16.12 is its only review so far; memory `project_pool_incentives`.
- **Not re-run here:** Part 4's 390 px iframe probe (documented method and fixtures above);
  nothing on a VPS.

Verified locally, one-shot only: `node --check` on the two touched files, the 16 suites, the
scratch recompute script (scratchpad, deleted). `git status --short` shows the same five
untracked files as Part 4 and nothing else.

---

### 10.4 Ownership-proof SET — backend (2026-09-22, add-ons — NOT VPS-tested)

Design contract: [`script07_design.md`](script07_design.md) §17. This is **Part 1 of five**
(backend); the account page is Part 2, the copy sweep Part 3, an independent review Part 4 and
VPS acceptance Part 5. §17.6 carries each part's state.

Replaces the **2-slot proof window** that had gated every self-service money action since
2026-07-17 (§10, audit §E/§F/§J3). The window compared a capture against its newer slot only, so
two facilities whose rigs reconnected in turn rotated it on every reconnect — re-stamping the age
the §J3-1 destination gate reads and lighting an "evidence changed" warning for honest churn.
The page's "use the same password on every rig" was a workaround for the slot count.

**Schema** (`lib/db.js`) — one new table and one new column, no `DROP COLUMN`:

```sql
CREATE TABLE IF NOT EXISTS miner_proofs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  grin_address  TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('ip','pass')),
  hash          TEXT NOT NULL,            -- 'v2$<b64>' or a carried-over 'v1$<salt>$<b64>'
  first_seen_at INTEGER DEFAULT NULL,     -- never updated on a live row; restarted when an evicted anchor returns (Part 4); NULL = migrated unknown = OLD
  last_seen_at  INTEGER NOT NULL,         -- refreshed on every match; the LRU key
  is_anchor     INTEGER NOT NULL DEFAULT 0,
  evicted_at    INTEGER DEFAULT NULL,     -- NULL = live; only an anchor is ever non-live
  UNIQUE (grin_address, kind, hash)
);
CREATE INDEX IF NOT EXISTS idx_miner_proofs_lru
  ON miner_proofs (grin_address, kind, evicted_at, last_seen_at);
-- miner_accounts + proof_salt TEXT DEFAULT NULL
```

The ten legacy columns (`last_ip`/`prev_ip`/`anchor_ip`, `last_pass_hash`/`prev_pass_hash`/
`anchor_pass_hash`, the four `*_at`) stay in the schema and are **read by exactly one function**,
the migration below. A grep for them across `web/07_mining_pool_public/` returns `lib/db.js`'s
schema and `lib/owner-proof.js`'s migration and nothing else.

**Capture / verify** (`lib/owner-proof.js`). `PROOF_SET_MAX = 10` live rows per (address, kind),
a module constant and deliberately not a setting. Per kind a capture does exactly one of:

| state | action | audit |
|---|---|---|
| value is already a LIVE row | `last_seen_at = now`. **`first_seen_at` never moves.** | none |
| the live set is EMPTY | insert; the row becomes the anchor | none |
| anything else (new value, or the evicted anchor returning) | needs `mayDisplace`; evicts LRU live rows first. A returning anchor is un-evicted with **`first_seen_at = now`** — its age restarts (Part 4, below) | `evidence_added` `{kind, live_after, evicted}` |

`evidence_displaced` is retired. Eviction is least-recently-**seen**, and an **anchor row is
flagged `evicted_at`, never deleted** — the one `DELETE FROM miner_proofs` in the codebase sits
behind `if (r.is_anchor) … else DELETE`.

`verifyOwnerProof` keeps its signature and every reason string; `slot` is now `'set' | 'anchor'`,
and **`'anchor'` only for an EVICTED anchor row** — a live anchor is an ordinary member, so an
actively-mining owner is not barred from the destination gate. `age_seconds` comes from
`first_seen_at`. **`requireBothProofs`' logic is unchanged** (Part 4 touched only its two error
strings); because a refresh never moves `first_seen_at`, the §J3-1 AND+AGE gate no longer
refuses an owner whose rigs merely reconnected. As first built, a returning evicted anchor kept its
original stamp and so became an aged, live `'set'` leg — weaker than the window, which gave a
returning value a fresh age. Part 4 restarts it (below).

**One salt per ADDRESS** (`miner_accounts.proof_salt`, 16 random bytes, base64), minted by
`getOrCreateSalt` with `UPDATE … WHERE proof_salt IS NULL` **then a re-read** — two rigs' first
shares landing together must agree on one salt, so the function never returns the value it just
generated. Rows are `v2$<hashB64>`; scrypt parameters unchanged (N=16384, r=8, p=1, 32-byte key,
16 MB). Digests compare with `crypto.timingSafeEqual`.

*Measured KDF cost per verify* (asserted by wrapping `crypto.scrypt`, not reasoned about — audit
§F2 sizes the per-IP throttle against this): **1** call on a v2-only set of any size, success or
failure, for input used as typed; **2** when the input is an IP whose canonical form differs from
what was typed and is also password-shaped (a compressed IPv6 like `2001:db8::1`: the IP set
needs the canonical spelling, the password set the raw one). Plus **one per legacy v1 row of each
kind tried** — up to 6 on a migrated account holding anchor/last/prev of both kinds — and no v2
digest at all while the account has no salt. **Transitional ceiling: 8** (2 + 6), above the old
window's 6, falling to ≤ 2 as captures rewrite v1 rows. *(As first written this paragraph said
"1 + n_v1"; Part 4 measured the 2 and the 8, and both are now asserted.)*

**Migration** — `migrateProofSet(db)`, synchronous, called **immediately before
`stratumServer.start()`** (an account reaching its first post-upgrade capture with an empty set
would anchor to whoever mined that share). As first built it sat where `backfillProofAnchors`
was — ~130 lines AFTER the listener start, behind `await nostrBridge.start()`; Part 4 moved it. `migrateOwnerProofHashes` and `backfillProofAnchors`
are **deleted**; their jobs are subsumed. Mapping: the anchor becomes an `is_anchor=1` row, live
when its stored string equals `last` or `prev` and otherwise `evicted_at = anchor_set_at`; `last`
and `prev` become live rows carrying their own `*_at` as `first_seen_at`. Rows insert anchor →
prev → last so `id` — the LRU tiebreaker when timestamps are unknown — runs oldest to newest. A
pre-v1 plaintext value is hashed with `scryptSync` **outside** the transaction.

*Idempotency proof, stated because there is no marker table (repo style):* the migration NULLs
all ten columns for every account it copied, and its `SELECT` is `WHERE <any legacy value> IS NOT
NULL`. A second run therefore selects zero rows, returns 0 and logs nothing. Asserted both ways —
the columns are NULL afterwards, and a second call inserts nothing.

**API shape.** `GET /api/account/:addr` drops the `evidence` object and gains
`proofs: { ip, pass, max, anchor, last_added_at }` — live counts per kind, the cap, whether an
anchor row exists at all, and the newest `first_seen_at` across both kinds.
`has_recorded_ip` / `has_recorded_pass` are derived from the counts (each includes its kind's
anchor, evicted or not, because an evicted anchor still verifies). `GET /api/admin/miners/:addr`
gains `proofs.{ip,pass} = { live, oldest_first_seen, newest_last_seen, anchor_live }`. **No
response body, anywhere, carries a proof value, a digest, `proof_salt` or a per-row capture
time** — `test-public-leakage.js` asserts that on both routes, on `index.js` as a whole, and on
every `console.*` line in `owner-proof.js`.

Observed live against the real `lib/db.js` schema (one-shot script, temp DB deleted): 3 IPs +
2 passwords → `{ip:3, pass:2, max:10, anchor:true, last_added_at:…}`; past the cap → `{ip:10, …}`
with the admin view reporting `anchor_live:0` for the evicted IP anchor while `proofs.anchor`
stays true; a never-mined account → all zeros, `anchor:false`, `last_added_at:null`.

**Tests** — `scripts/test-owner-gate.js` **19 → 36**, `scripts/test-public-leakage.js` **77 → 86**;
suite total **849 → 875 across 15 suites, all passing** (`npm test`, which also runs
`check-syntax`). Its `freshDb()` now builds the DB through `lib/sqlite-compat.js` rather than a
bare `node:sqlite` `DatabaseSync`: the bare one has no `.transaction()`, so a migration opening one
threw in the test and worked in production — the wrong way round for a test to be wrong. New
coverage: LRU eviction order; an anchor flagged not deleted, still verifying, still refused by the
destination gate, and refused outright under `allowAnchor:false`; re-activating an evicted anchor
gated by `mayDisplace` and not breaking the cap; three sites surviving six reconnects with
`first_seen_at` unmoved and **no audit row for a refresh**; one share creating but not adding;
the migration's mapping, column clearing and no-op second run; a v1 row verifying and being
rewritten as v2 in place; two concurrent first captures landing on ONE salt and ONE anchor; the
KDF-cost table above; and every reason string `index.js` maps.

**Not changed:** `PROOF_MIN_SHARES`, the (address, origin) lockout and its counters,
`pass_proof_state`, `getPasswordConsistency` (still live-session-based, still guarded on
`session.acceptedShares`), the withdraw/export rate buckets, `requireBothProofs`.

**Deltas from §17**, all additive:
- §17.4 asks `test-public-leakage.js` to assert the `proofs` shape and the absence of
  `proof_salt`; the Part-1 file list in the run plan did not name that file. Added here — it is
  an API-shape assertion and Parts 2/3 do not touch it.
- `_makeRoom` takes a `headroom` argument (1 for an insert, 0 for the migration's defensive
  trim). Evicting `live − max + 1` when nothing is being inserted would throw away a working
  proof for nothing.
- `is_anchor` is decided **inside** the INSERT statement via `EXISTS`, not from a snapshot read
  before the KDF. Two first captures racing through scrypt would otherwise each see an empty set
  and each claim the anchor. For the same reason `_captureProof` reads the rows **twice** — once
  to find which v1 hashes need testing, and again after the last `await`, so nothing that decides
  (live count, cap, LRU pick) is read across an await from the write that depends on it.
- `hashProof` (the v1 writer) is exported. Nothing in production writes v1 any more, but the
  regression suite needs to build a legacy row through the same code that parses one.

Verified locally, one-shot only: `node --check` on each changed `.js`, `npm test` (875/875), and
the runtime aggregate script above (scratchpad, temp DB deleted). No server was started.

#### Part 2 — account page (2026-09-22, `public_html/account-settings.html` only)

Renders what Part 1 returns. One file, no backend change, no new test.

- **On-record hint** — `proofHintText(a)`, a new function beside `renderPasswordProof`, replaces
  the two-boolean sentence with counts off `a.proofs`: *"On record for this address: 3 mining IPs
  and 2 rig passwords (up to 10 of each) · last added 2026-09-20 13:21"*. Singular/plural on both
  nouns; one count at zero names only the other kind and drops *"of each"*; `last_added_at` null
  drops the clause. Time via the page's `fmtWhen` (UTC, suffix-free — the deck head states it once).
- **Three branches, on purpose.** Counts when `proofs` is present; the old whether-not-how-many
  sentence when it is **absent** (an older backend or a cached response — a count the server did
  not send is not a fact about the account, and rendering 0 would read as "nothing recorded"); and
  a distinct line when both live counts are 0 but the write-once original survives, since that
  account *can* still reach its wallet and "No proof recorded yet" would be a lie to the one miner
  who most needs to know. That third state is reachable through the migration — an account whose
  `anchor_*` was set with both window slots empty lands as one evicted anchor row and no live row.
- **"Evidence changed" banner deleted** (design §17.2 #8), and the `evidence` argument with it —
  `renderPasswordProof(pp, proofs)` now takes the counts, because the cap is what its remaining
  warning is measured against. Neither fact is lost: *last added* is in the hint, and the "someone
  else mined to this address" explanation moved into the *Why does my rig password matter?* fold.
  *(2026-09-23: that fold was removed by the payout-rails fix; this explanation is now only an HTML
  comment above the gate label — §10.5 Part 3.)*
- **Password diagnostics.** `PASS_STATE_TEXT.ok` → **"Password recorded — this rig's password is
  on record and will work as proof."**; every reject state (too short / too long / too common /
  charset / invalid) keeps its text, they are real diagnostics. The live-session lines: the old
  **Mismatch** fired at *two* distinct passwords and told everyone to run one password everywhere
  — it is now **"Too many passwords"** and fires only past `proofs.max`; two or more within the cap
  is an OK **"On record"** line. *None usable* and *Partial* keep their logic.
- **`max === 0` means "the backend did not send a cap", never "zero allowed."** Both branches that
  depend on it fail quiet: no over-cap warning, and the multi-password line drops its *"both are on
  record"* verdict for a claim-free reading — the build that sends no cap is the 2-slot one, where
  that promise would be false.
- **Static copy.** The *Accepted:* line under the input ("any IP your rigs have recently submitted
  shares from … the pool keeps up to 10 of each"), and the fold: a new *What the pool keeps*
  paragraph (10 of each; a reconnect from a known IP refreshes it and does not restart the
  destination-change clock; past 10, the least recently used drops off), a new *If a proof appeared
  that you did not add* paragraph (the deleted banner's content), and *Setting one* with the
  same-password rule demoted to a convenience. The *can't be used to steal your coins* and
  *factory defaults* paragraphs are unchanged — both still true. *(2026-09-23: the whole fold is
  gone — §10.5 Part 3 has where each of these facts lives now.)*
- **DEMO dataset** now carries `proofs: { ip: 3, pass: 2, max: 10, anchor: true, last_added_at }`
  and `live.distinct: 2`, so the operator's no-API preview renders the shipped shape and shows the
  multi-password case as normal rather than as the warning it used to be. `evidence` is gone.

**Deviation from the run plan**, deliberate: the plan said keep *Partial* as it was, but its
sentence was *"Set the same password on every rig"* — a 2-slot workaround, and §17.5 names
`renderPasswordProof` as copy that must change. It now reads *"Set one on that rig too — it does
not have to match the others."* Logic unchanged. Part 3's grep (`last two|last-2|two most recent|
prev_*`) would not have caught the sentence.

**Numbers in prose.** The fold and the *Accepted:* line spell the cap as a literal **10**;
`PROOF_SET_MAX` is a hardcoded constant by design (§17.2 #1), not a setting, so there is nothing
to interpolate — but if it ever moves, these two strings move with it. The rendered lines
(hint, over-cap warning) all read `proofs.max` from the API.

**Not touched:** every backend file, `public_html/index.html`, the CMS defaults — Part 3 owned
those (done 2026-09-23, below).

Verified locally, one-shot only: `npm run check-syntax` (65 files + 32 inline `<script>` blocks,
which covers this page), `npm test` **875/875 across 15 suites, unchanged** — no suite asserts
this page's copy — and a scratchpad `vm` probe that pulls `proofHintText`/`renderPasswordProof`
straight out of the HTML and runs 22 assertions over all their branches (it caught two real
defects before passing: a fabricated timestamp in a fixture, and the *"on record"* promise on the
no-cap path). No server, no browser. Mobile: no block gained a fixed height — `.pass-diag` is a
wrapping flex column, the fold is `<details>` and ships collapsed — and the longest new uppercase
`<b>` label, **TOO MANY PASSWORDS** (18 ch), is shorter than the shipping
**PASSWORD UNSUPPORTED CHARACTERS** (31 ch), so no new overflow surface. The 390 px iframe probe
needs a browser and was **not** run.

#### Part 3 — copy sweep (2026-09-23, copy and comments only)

No logic changed. Started from the run plan's grep (`last two|last-2|last 2|two most recent|
prev_ip|prev_pass`) plus a wider one for the Part-2 lesson — the phrasing that states the 2-slot
rule without naming it (`same password on every|same PIN on every|same</em> one|proof window`).

| Surface | Change |
|---|---|
| `public_html/index.html` setup guide, step *Password* | "**Use the same PIN on every rig**" → each rig may have its own PIN, the pool keeps up to 10, one PIN everywhere is only easier to remember |
| `lib/pool-settings.js` Terms | ownership check = "a source IP your address has recently mined from, or the stratum password on one of your rigs … up to ten of each" |
| `lib/pool-settings.js` Privacy | "last two IPs / last two passwords" → up to ten of each, least recently used dropped past ten |
| `lib/pool-settings.js` FAQ ×3 | the *Password* bullet, "only your last two are kept", and the rotation answer ("the last two are both accepted") restated for a set of ten; different passwords per rig all work |
| `lib/pool-settings.js` | Terms / Privacy / FAQ *Last updated*: July → **September 2026** (those pages' content changed) |
| `index.js` | the `requireBothProofs` comment ("live last-2 window" → a live set row, age = write-once `first_seen_at`); the `nostr-destination` `API_DOC_META` row and the 409 `anchor_not_accepted_here` error text — both said "your original recorded proof", which since Part 1 means only an EVICTED anchor |
| `lib/stratum-server.js` | three "proof window(s)" comments → "proof set" |
| `lib/owner-proof.js`, `lib/db.js` | one stale "proof windows above"; the legacy anchor-column comment put in the past tense and corrected to say only an EVICTED anchor is refused by `requireBothProofs` |
| audit §J3 resolution pass + Status roll-up | pointer notes to design §17; which §J3 conclusions still hold, which are superseded. No finding rewritten |
| this file §2b runbook + §10 head, design §6 slatepack note | pointer / present-tense fixes |

`admin-panel/users.html` (named in design §17.5) states no proof window — its "window" is the
audit-log time range — so it is unchanged. `API_DOC_META` for `GET /api/account/:addr` was already
correct from Part 1.

**⚠ Installed pools keep the old CMS text.** The Terms/Privacy/FAQ bodies are *seed* values: `lib/db.js
migratePagesFromConfig` copies them into the `pages` table once (marker `_migrations.pages_seeded`)
and never again, and `POST /api/admin/settings/:section/restore` resets `pool_config` sections,
not `pages` rows — there is no restore-to-default for a page. A pool that has ever started keeps the
2-slot wording until the operator pastes the new text into those three pages in **Admin → Pages**.
Left as a finding for Part 4 (a copy sweep must not change behaviour); a fresh install gets the new text.

Remaining grep hits are deliberate history: the legacy-column schema and the migration that reads
it (`lib/db.js`, `lib/owner-proof.js`), comments that describe the old window in the past tense
(`index.js` migration call, `lib/miners.js getPasswordConsistency`, `owner-proof.js` header), the
regression tests that build legacy rows, and the dated audit findings.

Verified locally, one-shot only: `node --check` on the five edited `.js` files; `npm test` —
`check-syntax` (65 files + 32 inline blocks) and **875/875 across 15 suites, unchanged**. No server.

#### Part 4 — independent review (2026-09-23)

Read cold against design §17 + §17.4: the full `lib/owner-proof.js`, every reader/writer of
`miner_proofs` (grep: `owner-proof.js`, the two `index.js` views, `lib/db.js` schema — nothing
else), `requireBothProofs` and every `verifyOwnerProof` call site, the startup order, both work
guards in `lib/stratum-server.js`, `test-owner-gate.js` in full, the page's two renderers, and the
Part 3 diff. The ten questions and their answers, with the evidence, are design §17.7. What
changed in the code:

| # | Defect (confirmed before the edit) | Fix |
|---|---|---|
| 1 | **Migration ran AFTER the stratum listener.** `migrateProofSet(db)` sat ~130 lines below `stratumServer.start()`, behind `await nostrBridge.start()` — so with Nostr payouts on, shares were accepted (and could anchor an empty set to a stranger) while the relays answered. The §J3 `backfillProofAnchors` had the identical placement; the comment claiming "ahead of the stratum listener" was false for both. | `index.js`: call moved to immediately before `stratumServer.start()`. Source-order check added (fails on the old file: statement order wrong AND an `await` between). |
| 2 | **Racing duplicate capture evicted a second proof.** `_captureProof` re-located its pre-KDF match by the old hash string only; if a capture of the same value inserted it (or rewrote the matched v1 row as v2) during the v1 awaits, the re-read missed it, the insert path evicted an owner row, and the INSERT was then IGNOREd. Reproduced: a full set lost **2** rows for one new value and was left at **9**. Needs v1 rows for the await window — i.e. migrated accounts. | `lib/owner-proof.js`: the re-read also matches on the capture's own v2 digest. Now 1 row, set stays at 10. |
| 3 | **A returning evicted anchor kept its original `first_seen_at`.** Once live it verifies as `'set'`, so four shares from whoever holds that value now (the owner's old CGNAT or re-leased IP) turned the evicted-anchor refusal (§J3-4) into an aged destination leg. The window never had this: a returning value got a fresh age. The password leg still blocks theft; this is defence in depth, restored. | `lib/owner-proof.js`: re-activation sets `first_seen_at = now`. The one write that moves it, and only forward. Test asserts the age restarts and the leg is refused. |
| 4 | **`proof_too_recent` text quoted the wrong number.** It printed `cooldownH`, not the enforced `minAgeSec` — with the cooldown at 0 it told the miner "at least 0 h old" while refusing (pre-§17, from the §J3 self-review). | `index.js`: prints `Math.ceil(minAgeSec / 3600)`; the `anchor_not_accepted_here` text interpolates `PROOF_SET_MAX` instead of a literal 10. |
| 5 | **KDF cost under-stated** everywhere it was written (§17.4, this section, the `verifyOwnerProof` comment, whose memo note claimed the opposite of what the memo does). | Comments/docs corrected; the 2-digest case and the 8-call ceiling are now asserted. No behaviour change. |

Plus test coverage for a path that was claimed but not exercised: the migration check whose comment
said *"an anchor that EQUALS the current window value is ONE row, and it is live"* used data where
the anchor differed from both slots. The EQUAL case is the common one (the old backfill seeded the
anchor FROM `last`) and is now its own check — it already worked.

**Decided, not changed:**
- **CMS re-seed (Part 3's carry-over): stays an operator note.** The pages are operator-owned
  legal text, and a versioned re-seed would overwrite edits. The stale text is *understated*
  (says two are kept), not unsafe. A conditional re-seed of pages still byte-identical to the old
  default is possible later if it is ever wanted; it is not a safety fix.
- **The 409 `anchor_not_accepted_here` text (Part 3's rewording) is accurate** — it fires only
  for an evicted anchor, and it says so.
- **Open, for Part 5:** `pass_proof_state = 'ok'` reads *"Password recorded — … on record"* and the
  multi-password line says *"all of them are on record"*, but a NEW password on an address that
  already has one is inserted only at `PROOF_MIN_SHARES` (share 4), not share 1. Between the two
  the page over-claims. That gap is transient if share 4 comes in minutes, which is the §J3 open
  question Part 5 measures. Reword the text only if the measurement says it can take hours.

Tests: `test-owner-gate.js` **36 → 42**, suite **875 → 881** (`npm run test:unit`, exit 0, 15
suites). Each new regression check was run against the pre-review code first and failed there
(anchor age, source order; the race by the same scratch script before/after). No server started.

**Owed:** Part 5 (VPS acceptance). Nothing here has run outside a local harness.

### 10.5 Payout rails fix — Slatepack params, Tor probe, slimmer P-04 (2026-09-23, add-ons — NOT VPS-tested)

**Origin:** an operator test on 2026-09-22 found that **both** miner payout rails on the account
page (P-04) failed. Slatepack returned `failed to create slatepack: Wallet RPC error:
InvalidArgStructure "slate" at position 1`. Tor showed *"✗ not reachable"* for a wallet that Tiny
Explorer's wallet check (06d) reported as up. The work ran in three code parts plus this docs fold.
Suite **881 → 945** across 16 suites (`npm test`, exit 0). **None of it has run on a VPS.**

#### Part 1 — Slatepack: named params for `create_slatepack_message` (`lib/wallet.js`)

- **Root cause, confirmed:** `createSlatepackMessage` sent positional params
  `[token, sender_index, recipients, slate]`, but Owner API v3 declares
  `create_slatepack_message(token, slate, sender_index: Option<u32>, recipients: Vec<SlatepackAddress>)`.
  The wallet read the number `0` as the slate. The error names the argument the wallet
  **expected** at that position (`slate` at index 1), not the one it received. The Goblin/Nostr
  rail calls the same wrapper with `recipients: []`, so it was broken too. On the failure path
  `cancelTx` and `_reverseLock` still ran, so the failed tests stranded no coins. Each one did
  arm the post-return cooldown.
- **Fix:** the call now sends **named** params
  `{ token: null, slate, sender_index: senderIndex, recipients }`, which cannot be misordered.
  051 Fidelius and the 053 bridge already made this call with named params, and both work. The
  keys must match the Rust parameter names exactly. A misspelt key is **rejected, not ignored**:
  easy-jsonrpc (master, read 2026-09-23 in the Part 5 review) turns the missing real name into
  `MissingNamedParameter` and the stray key into `ExtraNamedParameter`. Not re-checked against
  the exact `easy-jsonrpc-mw` version grin-wallet v5.4.1 pins.
- **`_call` accepts both param shapes.** It fills an array's `params[0]` or an object's
  `params.token` through the new `_fillToken`, at **both** sites: the first call and the
  session-retry branch. The retry branch must refill the token too, because re-initialising the
  session rotates it. Missing it there is a bug that shows up only after a wallet restart.
- **`sender_index` stays `0`, never `null`.** With `0`, the miner's response slatepack is
  encrypted back to the pool's index-0 address, and `finalizeSlatepackWithdrawal` decodes it
  with `secret_indices [0]`. The 053 bridge uses `null` to stop a Tor auto-reply from bypassing
  its DB. That trap cannot apply here, because the pool's `owner_api` listener publishes no onion
  (memory `project_pool_wallet_combined_listener`).
- **Audit of the other 10 Owner calls** in `lib/wallet.js`, checked against v5.4.1
  `owner_rpc.rs`: `retrieve_summary_info`, `retrieve_txs`, `retrieve_payment_proof`,
  `get_slatepack_address`, `init_send_tx`, `tx_lock_outputs`, `slate_from_slatepack_message`,
  `finalize_tx`, `post_tx` and `cancel_tx` are all in the right order. `create_slatepack_message`
  was the only wrong one, and the only one converted.
- **Tests:** new `scripts/test-payout-rails.js`, wired into `test:unit`. It checks the wire
  shape (an object, not an array), the token, the slate passing through with its `id`,
  `sender_index 0`, recipients as given, the empty-recipients Goblin call, the token refill on a
  session retry, and that the array path is not regressed. With the old `wallet.js` restored,
  the shape checks fail.

#### Part 2 — Tor probe ported from 06d (`lib/wallet-tor.js`, `lib/socks5.js` NEW, `lib/config.js`, `index.js`)

- **Why the old probe said "offline" for a live wallet.** Four faults compounded:
  1. The timeout was **3000 ms**, but a cold onion connect routinely takes 5–15 s.
  2. The `socks` npm lib reports a timeout as `'Proxy connection timed out'`, and that string
     matched neither of `_torConnectOnce`'s patterns. So hearing nothing back fell through to
     `{ online: false }`, a **confident** offline built from no information.
  3. Retries reused one circuit, so retry 2 repeated retry 1's failure.
  4. A bare SOCKS CONNECT proves that a stream opened, not that a grin-wallet is there.

  The withdraw **pre-flight gate** runs the same probe, and a false `false` there is an HTTP 409
  that refuses the payout. So this bug also blocked payouts, not just the status line.
- **Fix: port 06d's probe**, which had worked live against the operator's wallet. It is copied
  in, not required across products, because the two products deploy separately.
  `lib/socks5.js` is 06d's zero-dependency SOCKS5 client. Its one deliberate change is the
  isolation-credential literal (`grinpool`). Its header gives a `diff` command that must print
  only that one line pair. `lib/wallet-tor.js` keeps the public contract,
  `probeToronlineStatus(address)` → `{ online: true | false | null, reason }`, and its bech32/onion
  derivation. That derivation was verified byte-identical to 06d's. The file header lists every
  divergence from 06d.
- **What the probe proves now.** It opens a SOCKS5 tunnel to `<onion>:80` (the wallet's HS
  virtual port) and **POSTs `check_version` to `/v2/foreign`**. A parsed JSON-RPC answer, or an
  HTTP 401, is the proof.
- **Tri-state, by reason code** (`REASONS` in `wallet-tor.js`; the route returns the codes
  verbatim):

  | `online` | reasons | meaning |
  |---|---|---|
  | `true` | `reachable`, `reachable_auth` | a grin-wallet answered (401 = one that asks for auth) |
  | `false` | `onion_unreachable`, `onion_timeout`, `no_answer`, `not_wallet`, `invalid_format` | our tor works and that wallet did not answer; or a non-wallet answered; or the address can never be paid |
  | `null` | `tor_unavailable`, `derivation_failed`, `probe_failed` | **we could not look** — says nothing about the wallet |

  `classifyProbeError` makes the false/null split using three signals, strongest first: a SOCKS
  reply byte, `proxyResponded` from `socks5.js`, then the error string. **A timeout with zero
  bytes back from the proxy is `null`, never `false`.** That is the line the old probe was
  missing. `invalid_format` → `false` is a deliberate divergence from 06d, which returns `null`:
  the pool is gating a payout, and "nothing can ever be sent there" is a decision.
- **Timing and retries.** `tor_check_timeout_ms` is now **8000** (was 3000) and
  `tor_check_retries` stays **2**, in both `wallet-tor.js` and `lib/config.js`. Every attempt
  carries its own SOCKS **isolation tag** (`grinpool-<n>`), so tor builds a fresh circuit for it.
  The probe stops early on `true`, on any `null` (our side is broken, so a retry only costs time)
  and on `not_wallet` (a stable fact about the far end). The connect function is injectable
  (`deps`), so the tests need no tor. `_torConnectOnce` and `require('socks')` are gone. No
  installer pins `tor_check_timeout_ms` into a pool config: the only pin under `scripts/` is
  06d's own 8000.
- **`GET /api/account/:addr/tor-check?fresh=1`.** A fresh request skips the 60 s cache, but only
  once the cached answer is **10 s** old (`TOR_PROBE_FRESH_FLOOR_MS`). A younger answer is served
  as-is, so a click-spammer cannot turn the cache off. The `torcheck` bucket (10/min), the
  in-flight dedup and the 404 for an address that never mined here all still apply. The result
  of a fresh probe is stored in the cache. The `API_DOC_META` row now lists the reason codes and
  the floor. **The pre-flight gate is unchanged.** It always probes fresh, never reads the cache,
  and still runs after `precheckWithdrawable`, an ordering that `test-rate-limits.js` asserts.
  It fails OPEN on `null` (with the `[tor-preflight] gate could not run` warning) and blocks on
  `false`.
- **Tests:** a Tor-probe section in `test-payout-rails.js` covers the classification with an
  injected connect, the defaults, the `?fresh=1` source checks, and real sockets against a fake
  SOCKS5 proxy bound in-process to 127.0.0.1. The regression check: with the old
  `wallet-tor.js` restored, a silent proxy gives `{ online: false, reason: 'unreachable' }`, and
  the test fails.

#### Part 3 — P-04 slimmed (`public_html/account-settings.html` only)

- **Tor pane: two buttons and one status line.** *Check Tor wallet* (`#acct-tor-check`, a quiet
  `.btn-quiet` variant of `.btn-save`) sits beside *Pay to Tor wallet* (`#acct-withdraw`). The
  explanatory paragraph and the `acct-tor-recheck` chip are gone: the Check button **is** the
  re-check, and it calls `?fresh=1`. `#acct-tor` stays **empty** until the miner clicks Check.
  While probing it reads *"Checking… (can take up to 30 s)"*, then one of three outcomes: *"✓ Your
  wallet answered"*, *"✗ No answer — start your wallet listener, or use Slatepack"* or
  *"Couldn't check from here — you can still request the payout"*. The raw reason goes into
  `title`. `torSeq` discards an answer that arrives after a newer check or a new lookup.
- **No probe on page load.** `lookup()` no longer calls `torCheck(addr)`; it calls
  `resetTorStatus()`. Before, every page view built a Tor circuit to the miner's onion. The pay
  path still probes fresh through the gate. Pay shows *"Checking your wallet over Tor, then
  sending… (up to 30 s)"*. On a gate 409 it writes the ✗ line and *"Not sent — nothing was
  deducted."*, which is accurate because the gate runs before the balance lock.
- **The *Why does my rig password matter?* fold is removed**, together with its `.gate-why`
  CSS, at the operator's request: it repeated the homepage setup guide. A single link replaces it:
  *Password rules → Miner setup* (`/#rx-miner-guide`). Where each of its facts lives now:

  | Fact | New home |
  |---|---|
  | it can't be used to steal coins; what the gate stops; a stranger's proof is harmless | **HTML comment above the gate label** + the withdraw route's comment in `index.js`. No miner-visible home. |
  | 10 IPs + 10 passwords kept | the *Accepted:* hint under the input + homepage setup guide |
  | a password survives an IP change; each rig may use its own | homepage setup guide |
  | defaults / repeats / straight runs / < 8 / non-Latin refused | homepage setup guide, the *(8–128)* label, the password diagnostics on a failed submit |
  | a returning IP only refreshes; LRU of 10 drops off, so a rotation never locks anyone out | design §17 only (no page) |
  | how to set one | homepage setup guide |

  ⚠ **This reverses a placement made by the proof-set work** (design §17.2 #8, and §10.4 Part 2
  above). That work moved the "can't steal" paragraph and the *someone else mined to this
  address* explanation **into** the fold. The operator chose less text over keeping them
  visible.
- **Other cuts.** The panel-title tagline is gone. The Slatepack steps are one line. The two
  textarea labels are shorter. The closing note is down to two sentences: one payout at a time,
  and an undelivered payout returns automatically. `#acct-fee-note` and its JS are gone, and the
  fee explanation is now the `title` on the *Withdrawal fee* label. **Still visible:** the fee →
  you-receive preview, the sub-threshold note, the *Accepted:* hint, the password diagnostics and
  the pending strip. Everything cut is kept as an HTML comment where it stood. P-04 went from
  **1014 → 342** visible words (847 → 175 without the Goblin-only destinations section).
- **Verified:** the suite is unchanged at 945, and `test-public-leakage` reads this page. A
  headless-Chrome probe against the demo account, at 1280 and 390 px in the atomic, light and aqua
  themes, showed 0 console errors, **0 tor-check requests on load** and no horizontal overflow.
  The real probe and the 409 branch were verified by reading only; the demo cannot reach them.

#### Part 5 — independent review (three fixes, each with a test that failed first)

Suite **945 → 960** (16 suites). All three new test groups in `test-payout-rails.js` failed
against the Parts 1–4 code and pass now.

- **A drip-fed reply held a probe open for about a day** (`lib/wallet-tor.js`). The reply phase
  had only `req.setTimeout`, which is an *inactivity* timer, and the far end of that socket is the
  address holder's own onion. One byte every few seconds kept resetting it until Node's 16 KB
  header cap. 06d has the same idle-only timer but caps concurrent probes at 4. The pool has no
  cap, so every withdraw POST could hold one request and one socket. **Fix:** an absolute
  `deadline` timer, so the whole reply must arrive within `tor_check_timeout_ms`. **Test:** a fake
  proxy that feeds one byte per 100 ms. The probe used to be still pending at 4 s; it now returns
  `no_answer` inside the budget.
- **Something other than SOCKS5 on `tor_socks_port` blocked every Tor payout**
  (`classifyProbeError`). A wrong protocol version, or refused auth, has `proxyResponded` set, so
  it scored a confident `false`. The port could point at tor's ControlPort or an HTTP proxy. **Fix:**
  `lib/socks5.js`'s own proxy-level messages classify as `tor_unavailable` → `null`, so the gate
  fails open. 06d still scores them `false`; this divergence is listed in the file header.
- **A 504 left a payout that the miner was told had failed** (`index.js` pre-flight gate). This was
  Part 4's open question, and the answer is yes. After nginx's 30 s it answers the browser 504
  (*"Withdrawal failed"*) and closes the upstream socket. Express kept running the handler, the gate
  passed, and `createWithdrawal` locked the balance and queued the payout. **Fix:** after the probe,
  `if (res.destroyed)` writes a `requester_gone` audit row and returns without creating anything.
  It has to be `res.destroyed`: Node ≥ 16 sets `req.destroyed` on every request once the body is
  read. The suite proves both on the running Node, and a source check pins the guard between the
  probe and `createWithdrawal`.

#### Open follow-ups (not fixed here)

- **Worst-case probe time still exceeds the `/api/` read timeout.** The worst case is
  `tor_check_retries × (connect + reply)` = 2 × 2 × 8 s ≈ **32 s**. The pool vhost's
  `location /api/` sets `proxy_read_timeout 30s` (`07_grin_mining_public_pool.sh`). Since Part 5
  this can no longer create a payout the miner never saw, but a probe that runs slow still shows
  *"Withdrawal failed"*, and the miner has to press Pay again. The real fix is to raise that
  location's timeout, or give withdraw its own location. The alternative is to cap the probe's
  total time below 30 s.
- **No global in-flight cap on probes.** 06d caps them at `tor_check_max_inflight` (4). Since
  Part 5 each probe is bounded (≈32 s), so concurrency is limited by the per-IP `withdraw` and
  `torcheck` buckets, but not across IPs.
- **`?fresh=1` sharpens the uptime signal** from 60 s to 10 s per address, within the `torcheck`
  bucket. That is a design trade against the uptime signal §J3-9 accepted; nobody has signed it off.
- **`socks` is still in `package.json`, but nothing requires it.** Dropping it is a lockfile
  change (memory `reference_npm_lockfile_deploy_gate`), so it was left for a deliberate commit.
- **Two stale comments:** "≤6 s" for the probe in `withdrawal-scheduler.js`, and the
  `rate-limiter.js` `torcheck` bucket comment, which predates `fresh`.
- **P-08's `#wd-proof-note` is 137 words.** Part 3 proposed a cut in its report but did not
  make it.

**Owed:** VPS acceptance (Part 6): testnet first (listener
up, listener down, pool tor stopped → fail-open, a Tor payout with its proof, a Slatepack
round trip, a Slatepack abandoned to its TTL), then mainnet.

### 10.6 Donations v2 — per-share donation + reviewed donor profiles (design §18; 2026-09-24, add-ons — NOT VPS-tested)

Design contract: [`script07_design.md` §18](script07_design.md). Built in seven parts. This
section gets one sub-heading per part as it lands. **Nothing here has run on a VPS.**

#### §18 Part 1 — per-share donation (2026-09-24, uncommitted)

**What changed in the money.** A `donateN` tag now donates N % of the PPLNS credit **that
share** earns, read from `shares.worker_name` at distribution. Nothing is stored per address.
- `lib/rewards.js`: each `distribution` entry gets
  `donate_pct = parseDonateToken(share.worker_name)?.percent ?? 0`. `creditBalances` builds
  `donateMap` (address → Σ credit × pct/100) next to `minerMap`, in the same order, and passes it
  as the 4th argument of `applyToDistribution`.
- `lib/incentives.js applyToDistribution(blockHeight, minerMap, poolFee, donateMap)`: the
  donation leg iterates `minerMap`, so only an address this block credited can be debited. It
  reads `donateMap.get(address)`, clamps to `min(donated, gross)`, and skips reserved addresses.
  It runs only when `incentives_enabled` **and** `allow_miner_donations` are on. The ledger shape
  is unchanged: one `debit/donation` per address per block and one `prize_pool` `credit/donation`.
  `donor-ledger.js`, the prize-pool statement and `reconciliation.js` needed no change. The
  invariant test below checks that pot credits equal the sum of donor debits.
- **Removed:** `IncentivesManager.donationPercent` + `setDonation`; in `lib/stratum-server.js`
  the parked donation (login block, the `PROOF_MIN_SHARES` donation branch,
  `_applyParkedDonation`, `_captureDonorName`), plus its now-unused `IncentivesManager` and
  `donor-names` requires and the `this.incentives` field; `miners.js` session `donationPercent`;
  `validateUsername`'s `donor_label`. `validateUsername` still returns `donation_percent`, but
  nothing stores it. `PROOF_MIN_SHARES` stays because ownership-proof capture still uses it.
- The `miner_incentives.donation_percent` column and the six v1 `donor_*` columns stay in the
  schema. **Nothing reads the percent column.** `lib/donor-names.js captureDonorName` stays in the
  lib with **no production caller** until Part 3 removes v1 moderation. Names v1 already stored
  still display through `displayState`.

**Live readings (§18.3).** `lib/donor-ledger.js liveDonations(sessions)` is pure. It reads
MINING sessions only (`acceptedShares > 0`) and counts distinct worker names. It returns
`Map<address, { rigs_online, rigs_donating, pct_min, pct_max, donating_workers: [{name, percent}] }>`.
`donate0` counts as online, not as donating. The export `NO_LIVE` is the empty reading. The
callers apply the `donationsActive()` gate. Every added field is additive, and the kept fields
still feed today's pages until Parts 3–5:
| Surface | Adds | Kept (for the current page) |
|---|---|---|
| `GET /api/account/:addr` | `donation: { rigs_donating, rigs_online, pct_min, pct_max, workers }` | `donation_percent` = `pct_max` |
| `GET /api/account/:addr/workers` | per worker `donate_percent` (null = untagged, or donations off) | — |
| `GET /api/pool/donors` | per card `rigs_donating`, `pct_min`, `pct_max`; `totals.active_donors` = addresses with `rigs_donating > 0` (no more `miner_incentives` COUNT); `donorWall` takes `live` in place of `rigsOnline` | `current_percent` = `pct_max`, `rigs_online` |
| `GET /api/admin/donors` | per row `rigs_online`, `rigs_donating`, `pct_min`, `pct_max`; a row now exists for a debit, a **live** tag (only while donations are on) or a stored name — the `WHERE donation_percent > 0` is gone | `current_percent` = `pct_max` |

API reference rows updated for the three public routes.

**Upgrade effect — put this in the release note.** A v1 address-wide % **stops at deploy**. A
miner who tagged one of five rigs now donates from that one only. A miner who removed a tag but
never sent `donate0` stops donating. Shares already in the PPLNS window keep their tag, so for
about an hour after a rename, a block found then can still take the old tag's cut. The testnet
pool ran the v1 tag with a live miner (§16 intro). Tell the operator before deploying there.

**Interim copy gap (until Part 5).** `account-settings.html` still renders
`donation_percent` as *"N% of new earnings"*. That is now the highest tag among the live rigs,
not an address-wide cut. The row's tooltip still describes the v1 `donate0` ceremony and the
`yourbrand-donate10` name. `donate.html`'s D-01 copy also still describes v1 (Part 4). Neither
page reads a wrong NUMBER. The words are wrong until those parts land.

**Tests.** `npm test` **1134 → 1145**, 19 suites, exit 0.
- `test-money-path.js` 32 → 47, new §3. Cases: one tagged rig of two (only that share's credit ×
  10 %); `donate100` (donated == gross exactly, balance unchanged net); mixed 5 % + 20 %; a
  stranger's `donate100` share on a victim's address (moves only that share's credit); the dead
  column set to 100 with no tagged share (moves nothing); donations off; incentives off; and an
  out-of-range or malformed tag. Two invariants hold for every address in each block: donated ≤
  gross, and prize-pool donation credits = Σ donor debits.
- `test-donor-league.js` 68 → 77: `liveDonations` unit tests (distinct names, the pct range over
  donating rigs only, `donate0`/`donate101`, no-share sessions excluded, junk input) and the wall
  built from `live` (mixed tags, paused, `active_donors` counting an address with no card yet,
  the dead column ignored, switch off, junk readings bounded). The old `current_percent`-from-column
  and `rigsOnline` checks were rewritten.
- `test-donor-names.js` 156 → 145: the 11 checks that drove `_applyParkedDonation` /
  `_captureDonorName` were deleted with the code. The lib's capture tests still run until Part 3.
- `test-stratum-guards.js` 71 → 68: the three `donor_label` checks and the four-field check
  became one check for three fields. The tag grammar checks are unchanged.
- `test-owner-gate.js` stays at 42. The §J3-5 check used to assert that `setDonation` runs on the
  share path. It now asserts that `stratum-server.js` stores no donation at all and that
  `incentives.js` never reads `donation_percent`.
- `test-public-leakage.js` 87 → 88: §9's rig-count check now asserts the route goes through
  `liveDonations` and that the share bar lives there. A new check asserts the wall never reads
  `donation_percent`.

#### §18 Part 2 — donor-profile backend (2026-09-24, uncommitted)

API only. Nothing public reads a profile yet: the wall still shows v1 names until Part 4, and
no admin route can approve anything until Part 3.

**Schema** (`lib/db.js`, in the `CREATE … IF NOT EXISTS` list, so new and existing DBs both get
it and no migrate helper is needed). `donor_requests`, `donor_blocks`, and the three indexes
match §18.4 exactly. The two partial unique indexes (`uq_donor_req_pending`,
`uq_donor_req_approved`) are the "one pending + one approved per (address, kind)" rule. The v1
`donor_*` columns are untouched.

**`lib/donor-profiles.js`** (new; no dependency on `index.js` or `donor-ledger.js`):
- **Name**: `normaliseName` / `validateName`. ASCII whitespace is collapsed. Anything outside
  `A-Z a-z 0-9 space - _ . & '` is refused, including NBSP, zero-width characters, bidi overrides
  and Cyrillic look-alikes. The name is 2–32 characters with at least one letter or digit, and case
  is kept. A non-string is refused as `name_invalid`, not coerced. Codes: `name_invalid`,
  `name_length`, `name_charset`, `name_no_alnum`. Each message states the rule.
- **Banner**:
  - `sniffBanner` uses `asset-manager.js`'s binary `SNIFFERS` only. That array is now exported;
    `detectImage` is never called.
  - `parseDimensions` reads the PNG IHDR (it must be the first chunk, length 13), the GIF
    logical screen, or the JPEG's first SOFn. The JPEG walk skips APPn/DQT/DHT and fill bytes, and
    refuses at SOS or EOI. Every read is bounds-checked, and the parser returns null on any input,
    so nothing throws.
  - `validateBanner` enforces 320–1600 × 80–400 px, 2:1 to 8:1, and ≤ 300 KB. It returns
    `ext`/`mime` from the sniff plus dims, bytes and sha256. Codes: `banner_missing`,
    `banner_too_large`, `banner_type`, `banner_unreadable`, `banner_dimensions`, `banner_aspect`.
- **Donor transitions**:
  - `submitName` / `submitBanner` require `opts.isDonor === true` (fail closed). The caller reads
    the ledger. They re-check the account and the block inside the transaction.
  - An existing pending request becomes `replaced` and loses its blob.
  - A unique-index hit comes back as `{ code: 'conflict' }`. The test proves this with a real
    constraint, not a stub.
  - `withdraw` covers a pending request; `removeLive` covers the live one.
- **Admin transitions** (written and tested now, wired by Part 3): `approve`, `reject`, `block`,
  `unblock`, and `removeLive` with `adminId`. Each writes its `admin_audit_log` row
  (`target_type 'donor'`) inside the transaction: `donor_request_approve`, `donor_request_reject`,
  `donor_profile_remove`, `donor_block`, `donor_unblock`. Every `:id` goes through `parseId`. A
  reason goes through `cleanReason`: one line, no control characters, ≤ 200 characters. A blank
  reason is stored as NULL.
  - `approve` on a banner re-validates the **stored** bytes and takes the extension from that
    sniff.
  - It writes `uploads/donors/<16 hex>.<ext>` (mode 0644, `wx`, containment-checked) **before**
    the transaction and unlinks it if the transaction fails.
  - It unlinks the superseded file after the commit. A failed unlink comes back as `warning`; it
    does not abort.
  - It refuses a blocked address's request.
- **`profileFor`** builds the account's `donor_profile`, and **`publicProfiles`** builds the
  wall's `Map` (approved + unexpired only; Part 4 applies the slot rule). Neither selects
  `image`, and neither reads `name` from a non-approved row. An item expires `months` after
  the **later** of the last debit and its approval. Name and banner expire separately.

**`lib/donor-ledger.js`** gains `leagueRank(db, address, opts)`: the wall's own ordering, 1-based,
or null for the past strip and for anything below `LEAGUE_LIMIT`. A test proves it agrees with
`donorWall`'s numbering.

**Settings.** `donor_banner_slots` has a default of 5, is validated as an int 0–10, and is
re-bounded on read as `donorSettings().bannerSlots`, where junk reads as 5 and `'0'` as 0.
`donor_censored_display` stays until Part 3.

**`index.js`:**
- **`requireBothProofs(addr, body, reqIp, action, purpose = 'destination')`.** `PROOF_PURPOSES`
  changes only the wording. The Goblin texts are byte-identical: the old and new bodies were run
  against stubbed proofs over all 8 refusal and success paths, and all 8 compared equal.
- **Routes** (`rateLimiter 'withdraw'`, both proofs aged, `auditOwnerProof` as
  `donor_profile_submit` / `_withdraw` / `_remove`). The two submits refuse in this order:
  donations off (503), then no account (404), then blocked (403), then `not_a_donor` (409), then
  bad input (400/413), then the proof codes. The input is checked before the proofs, so a typo
  never burns a proof attempt. The banner route runs the four checks that need no body
  **before** multer reads it.
  - `POST /api/account/:addr/donor-profile/name` returns the typed name, and only this route
    does.
  - `POST …/donor-profile/banner` is multipart, with `file` plus the two proof fields.
  - `DELETE …/donor-profile/:kind` takes `{ which: pending|live }` and needs both proofs. It does
    **not** need donations on, a debit, or an unblocked address, because removing your own data
    is always allowed. It returns 404 before spending a proof attempt when there is nothing to
    act on.
- **`GET /api/account/:addr`** gains `donor_profile`, guarded to `null` on failure.
  `slot_rank` costs one ledger scan and only runs for an address that has donated.
- **API reference**: three new rows, and the account row documents `donor_profile`.

**Upload size, measured, not assumed.** A one-shot run fed multer's real stream parser a fake
request, with no server.
- Busboy trips `LIMIT_FILE_SIZE` when a file **reaches** the limit. So the limit is
  `MAX_BANNER_BYTES + 1`: exactly 300 KB passes to `validateBanner`, and 300 KB + 1 is refused.
- Multer stops **buffering** at the cap but reads and discards the rest of the body before the
  413 goes out. Memory per request is bounded at about 300 KB.
- The total body is bounded by nginx: the public `location /api/` sets no
  `client_max_body_size`, so the 1 MB default applies.

**§18.4's deploy claim, verified in `07_grin_mining_public_pool.sh`.** The claim was "no
deploy-script change".
- The nginx `location /uploads/` aliases `$POOL_APP_DIR/uploads/` with nosniff and the sandbox
  CSP.
- Both backend rsyncs pass `--exclude='uploads'`.
- `07_lib_pool_backup.sh` lists `uploads`.
- `uploads/donors/` is created by the app (0755) on the first approval.

**Tests.** `npm test` **1145 → 1298**, 19 → 20 suites, exit 0. The +153 is exactly the new
suite, so no existing suite changed.

`scripts/test-donor-profiles.js` (153) was added to `test:unit` after `test-donor-league`. It
covers:
- the name rules;
- sniff and dims on hand-built PNG/GIF/JPEG, including truncated, lying, zero and 2³²-wide
  headers, SVG, WEBP, and the 300 KB / aspect / size edges;
- a fuzz pass over 3,500+ truncated and random inputs: nothing throws, and nothing out of bounds
  is accepted;
- every transition, including both unique indexes directly and the conflict mapping via a real
  constraint;
- the file writes: one file, the submitted bytes, a second approve deleting the first, and an
  unwritable dir leaving the request pending with its blob;
- `profileFor`: never carries the pending name, bytes or `decided_by`; handles rejection
  supersession and admin-vs-donor removal;
- `publicProfiles`: excludes pending, rejected and expired; a non-conforming stored filename
  never becomes a URL;
- the settings bounds;
- `leagueRank`;
- route wiring read as text: withdraw limiter, the `'donor_profile'` gate on all three routes,
  the banner route refusing before multer, input validated before proofs, and the account route
  reaching `donor_requests` only through `profileFor`.

#### §18 Part 3 — admin review queue + moderation swap (2026-09-24, uncommitted)

Admins can now approve profiles. v1's post-moderation is gone. An approved **name** shows on the
wall from this part on. **Banners** still reach no public page until Part 4.

**Admin routes** (`index.js`, the `DONORS (Admin only)` block). All reads are `secureAdmin`. All
writes are `freshAdmin`, and each one delegates to the Part 2 lib, which writes the state change
and its `admin_audit_log` row in one transaction.

| Route | Does |
|---|---|
| `GET /api/admin/donors/requests?status=&limit=` | The queue. `status` is a closed enum and defaults to `pending`, oldest first. The decided statuses are the history, newest decision first. Each row gets `rank`, `lifetime_donated` and `last_donated_at` from one ledger scan. |
| `GET /api/admin/donors/requests/:id/image` | Returns the pending blob or the approved file. Headers: `Content-Type` = the stored mime (png/jpeg/gif only, anything else is refused), `nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cache-Control: no-store`, `Content-Length`. No bytes → 404; bad id → 400. |
| `POST …/requests/:id/approve` · `…/reject {reason}` | `approve()` / `reject()`. A banner approve with no uploads dir → 503 before the lib, since the lib would throw. |
| `POST /api/admin/donors/:addr/remove {kind, reason}` | `removeLive()` with `adminId`. `kind` is a closed enum. |
| `POST /api/admin/donors/:addr/block {reason}` · `/unblock` | `block()` also withdraws pending requests. The note stays admin-side. |
| `GET /api/admin/donors/summary` | `{ pending_requests }`, which drives the nav badge. |
| `GET /api/admin/donors` | Rewritten list. Per row: live `name` / `banner` (with the donor's own expiry state), `pending: {name, banner}` and `blocked`. Workers carry `donate_percent`. `current_percent`, the `donor_censor*` fields, `is_new`, `renamed_while_censored` and `new_names_7d` are gone. A row exists for a debit, a live tag while donations are on, or **any profile row or block**, so a blocked address can be unblocked. |

`:addr` goes through `GRIN_ADDR_RE`. Lib codes map through one `DONOR_ADMIN_CODES` table.
The dashboard's `new_donor_names_7d` became `pending_donor_requests`, and the Overview tile
changed with it.

**Removed:** the `censor` / `uncensor` routes, the rescan-on-settings-save hook,
`donor_censored_display` (default, validator and form), and in `lib/donor-names.js`:
`captureDonorName`, `rescanAll`, `adminCensor`, `countNewNames`, `NEW_NAME_DAYS`,
`CENSORED_MARKER`, `CENSORED_DISPLAY_VALUES`, `displayState` and `matchBlocklist`.
- A pool that still has a `donor_censored_display` row in `pool_config` is harmless: nothing
  reads it and no form binds it. A save that sends the key now fails with `Unknown key`.
- `lib/donor-names.js` kept `normalise`, `parseList`, `poolNameEntry`, `matchEntries`,
  `RESERVED`, `STARTER_BLOCKLIST`, `addMonthsUtc` and `donorSettings`. It gained
  `nameFlagContext` / `nameFlags` for the queue flags.
- `normalise` now also strips space, `.`, `&` and `'` (the v2 name separators), so
  `Acme & Co.` and `acme co` compare equal.
- The `donor_*` / `donation_percent` columns on `miner_incentives` stay in the schema, and
  nothing reads them any more.

**Flags** (hints, never decisions), computed at queue-read time from one context per read:
- `reserved`: a fixed word, or the pool's name if it is 3+ characters.
- `word`: an entry from the operator's list.
- `same_as_donor`: the addresses of **other** donors whose approved name normalises the same.
  Expired approvals count, because an expired name comes back with the next donation.

300 names against a 4,000-entry list flag in milliseconds, because the list is parsed once.

**`lib/donor-profiles.js` admin reads** (new):
- `adminQueue`: never selects `image`. `has_image` is true only for a pending blob or an
  approved file of the exact server shape. `current` is the address's approved item of the same
  kind, so a rename reads as a rename.
- `requestImage`: containment and `FILE_RE` checks on the approved file. A missing file → `no_image`.
- `adminProfiles`: uses the same `isExpired` rule as `profileFor`.
- `pendingCount`.

**v1 names stop showing everywhere.** `donorWall` now reads names from `publicProfiles`, which
returns approved, unexpired rows only. The wall response dropped `censored_display`.
`/api/account/:addr`'s `donor_name` / `donor_name_state` are **derived from `donor_profile`**
(`none` → `masked`). v1 names were never reviewed, so pre-moderation starts clean, as the plan
notes. Part 4 still owns banners, the slot rule and `current_percent`.

**`admin-panel/donors.html`** (rewritten). The page has three sections, so the section rail
picks up three chips:
1. **Review queue** (an AdminTable). Name requests show in the mono face with their flags and
   the live name they replace. Banners show the image and its dims, KB and mime.
   - Each row has an inline reason box. Its note says the reason is shown on the donor's public
     account page.
   - A typed reason survives repaints: it is written through to a `Map`, and the row reads it
     back.
   - The queue does **not** poll, because a timer repaint would wipe a reason being typed. It
     reloads after each decision and on Refresh.
2. **Donors.** Live name + state, the banner thumbnail (public `/uploads/donors/` URL,
   shape-checked) with "showing / not in top N", pending and blocked badges, the donating %
   range, and "k of n rigs". Actions: ✂️ remove name, 🖼 remove banner, 🚫 block / ✅ unblock.
   Remove and block use an **in-page** reason dialog (`.modal-overlay`, never `prompt()`).
   Unblock uses one `confirm()`.
3. **Donation settings.** The word list is relabelled *"Flag words — highlighted in the review
   queue"*. `donor_banner_slots` was added, and the expiry field was renamed "Profile expiry".

`admin-shell.js`: the badge now shows the pending count, and `AdminTable` gained an optional
`onRender(tbody)` hook. The hook is try/caught and runs only after real rows are painted. The
queue uses it to wire the reason boxes and each banner's error handler.

**Banner previews: a plain same-origin `<img src>`, no CSP change.** Each queued banner's `src`
is `/api/admin/donors/requests/<id>/image`. The access token is an httpOnly `SameSite=strict`
cookie on the default path, so the request carries admin auth. That also means §18.6's premise
("a plain `<img src>` would not carry admin auth") was wrong.
- The route's own headers govern every way the image is viewed, including *Open image in new
  tab*: the stored mime, `nosniff`, and `default-src 'none'; sandbox`.
- A failed load (the request was decided meanwhile, the file is gone, the session expired)
  becomes a line of text. The error listener is attached by `onRender` in the same task that
  paints the row.
- The admin CSP stays `img-src 'self' data:`, and a test pins it without `blob:`. No
  **Setup nginx** re-run is needed.

The first build used `adminFetch` → blob → object URL, and added `blob:` to the admin CSP. It was
switched the same day, on security grounds: an object URL is a copy of the bytes on the admin
page's origin and does **not** carry the route's sandbox headers. That approach also needed the
CSP widened and an nginx re-run that a code deploy does not perform. What it bought was only
convenience: the server's refusal text, and no refetch on a repaint of a handful of admin-only
images. See design §18.11 *Part 3* #1.

**Tests.** `npm test` **1298 → 1310**, 20 suites, exit 0.
- `test-donor-names.js` 145 → 92. The capture, rescan, `displayState`, censor and new-names
  blocks were deleted with the code. Added: the new separators, the flag tests (including 300
  names × 4,000 entries), a "removed API stays removed" block, and the `donor_banner_slots`
  bounds. It also checks that a save carrying `donor_censored_display` is refused.
- `test-donor-league.js` 77 → 72. The name block was rewritten over `donor_requests`: approved
  shows as typed; pending, rejected and removed names never show; a v1 `donor_name` is not read;
  expiry and expiry-0 are covered. A leak sweep checks for pending names and reasons, and
  `censored_display` is gone from the shape.
- `test-donor-profiles.js` 153 → 182, new [9] admin reads:
  - queue order, flags, `current`, and no `image` key or Buffer;
  - the closed status enum, including an array and SQL text;
  - image bytes for pending and approved rows, and the refusals: name row, junk ids, a tampered
    mime, a traversal filename, a deleted file, and a rejected request;
  - block emptying the queue;
  - `adminProfiles` states and expiry parity with `profileFor`.
- `test-admin-guards.js` 79 → 102, [6] rewritten:
  - the tier of all nine routes;
  - censor/uncensor absent, which means 404, and no catch-all;
  - every write delegating to the lib with admin id + ip, with no inline SQL;
  - `GRIN_ADDR_RE`, the closed `kind`, and the two 503s;
  - the image route's four headers and its 404/400;
  - the rescan gone from the settings save;
  - the dashboard and summary counts.
- `test-admin-panel.js` 71 → 90, [9] rewritten, plus a §J14-4 check that `img-src` stays `'self' data:` with no `blob:`. It covers:
  - page order;
  - the settings-id sweep against live defaults, with `donor_censored_display` on no page;
  - `settings-skip` on every input outside the form;
  - `this.dataset` on every action, and `adminFetch` for every write;
  - the in-page dialog, and the reason-is-public labels;
  - the same-origin `src` (id URL-encoded), no object URL or blob anywhere, and a failed load turning into text;
  - the thumbnail URL shape;
  - the queue not polling, and reasons surviving a repaint;
  - escaping;
  - `onRender` being try/caught.
- `test-public-leakage.js` 88 → 87. §9's `displayState` checks were replaced with:
  - the wall reading `publicProfiles`, with no v1 column and no marker anywhere;
  - `publicProfiles` and `profileFor` never selecting `image` or a non-approved name;
  - **an enumerated inventory of every route that touches `donor_requests`**. The public ones
    must be exactly the reviewed five, no public route may call an admin reader, and every admin
    one must be `secureAdmin` / `freshAdmin`. A new public route fails the test until it is
    reviewed;
  - the account route deriving its two name fields from `donor_profile`.

Also run once, not kept in the repo: a jsdom render of `donors.html` with the real
`admin-shell.js` and stubbed `API`/`adminFetch` (26/26 after the switch to a plain `src`). It checked:
- hostile names, flag words, worker names and a `javascript:` banner URL all render as text or
  not at all;
- the same-origin `src` on both banners, with no image going through `adminFetch`, and a failed
  load becoming text;
- a reason surviving a search repaint;
- reject posting the typed reason, and approve / remove / unblock posting;
- Escape cancelling a block;
- `prompt()` never being used;
- no script errors.

#### §18 Part 4 — public wall: `/api/pool/donors` v3 + `donate.html` (2026-09-24, uncommitted)

**The response (v3).** Built in `lib/donor-ledger.js donorWall()`. The route in `index.js` is
unchanged apart from its comment.
- Every card gains `banner`: `{ url, width, height }` or `null`. It is set only on a **league**
  card whose rank ≤ `donor_banner_slots`, and only when the address has an approved, unexpired
  banner (from `publicProfiles`) whose stored width and height are positive integers. Past cards
  are always `null`: they reach the card builder with `rank` null, and the slot test needs a
  safe-integer rank ≥ 1.
- `ranking` gains `banner_slots` (0–10). This is how the page learns N for its Top-N spotlight.
  It is bounded by `bannerSlots()`, now exported from `lib/donor-profiles.js`, so a raw `ds` that
  skipped `donorSettings()` still reads 0–10 rather than NaN.
- `current_percent` is **dropped** from the card. It was a v1 alias of `pct_max`, and
  `donate.html` was its last reader. A grep of `public_html/`, `admin-panel/`, `lib/` and
  `index.js` finds only the comment that records the removal.
- The `API_DOC_META` row for `GET /api/pool/donors` is rewritten to the v3 card list, with the
  banner rule and `banner_slots`. The route comment's v1 phrase "a stored % is dormant" is
  replaced with the per-share wording.

**The page (`public_html/donate.html`).**
- **D-01 is rewritten** per §18.7. The table now has four rows: `rig01-donate10` (this rig only,
  other rigs unaffected), whole-name `donate10`, plain `rig01` (`rig01-donate0` is the same), and
  typos ignored. The note leads with *"To change or stop: rename the rig and restart the miner…"*.
  The `yourbrandname` row, the raise row and the name ceremony are gone.
- **New D-01b "Your donor name & banner"**: where to set it (account page → Donor profile), the
  two proofs (a mining IP *and* the rig's stratum password), reviewed first, and the banner spec
  (800 × 200 recommended, PNG/JPG/GIF, ≤ 300 KB, top N only). Two lines follow the API's
  `ranking`:
  - the banner line: "the top 5 donors", or "Banners are switched off on this pool" at 0;
  - the expiry sentence: N months, or "stay up for as long as the pool keeps them approved" at 0.

  The fallback line ("Can't pass the check? Ask the pool operator.") carries branding.js's
  existing `data-brand="contact-link"`. That link stays hidden when no contact email is
  configured, and the sentence still reads correctly without it.
- **D-03 Top-N spotlight** above the compact league, for ranks 1..`banner_slots`:
  - Rank 1 spans the row and 2..N share the grid.
  - The banner sits in a fixed **4:1 box**: `aspect-ratio: 4 / 1`, the `<img>` absolutely
    filled with `object-fit: contain`, `width`/`height` attributes, `alt` = the name or
    "Donor #N", `loading="lazy"`.
  - A spotlight card without a banner shows the name large in the same box, so the grid stays
    even. Under a banner the name is repeated as text, because a banner may be a logo alone.
  - Ranks N+1.. keep the compact cards. At `banner_slots` 0 there is no spotlight, and the
    whole league renders as compact cards.
- **Card copy (§18.3).** The live line is *"10 % of new earnings from 2 rigs"*; mixed tags give a
  range (*"5–20 %"*), and none gives *"paused — no tagged rig online"*. The meta line is
  *"since 2026-09-21 · 2 rigs donating"*, with the rig count left off when paused. The badge is
  now a sentence-case tag instead of an uppercase pill, so it can wrap at 390 px.
- `nameCell` lost its v1 `censored` branch, and the `.donor-name.censored` CSS went with it. The
  disclaimer now reads *"Names and banners are chosen by donors and reviewed by the pool before
  they appear."*
- **The page keeps its own banner fence.** `bannerOf()` renders an `<img>` only for a URL that
  matches the server's exact file shape (`^/uploads/donors/<16 hex>.(png|jpg|gif)$`), which is
  stricter than the plan's "starts with /uploads/donors/", and only with positive-integer dims.
  The URL and `alt` go through `escHtml`. It is the page's only `<img>`.

**Deploy.** No nginx, deploy-script or schema change. Approved files are served by the existing
`location /uploads/` (verified in Part 2, §18.11 *Part 2* #11). `donate.html` and the backend
ship together in one deploy. A browser holding a cached pre-v3 page would read the missing
`current_percent` as 0 and show "paused" until it reloads.

**Tests.** `npm test` **1310 → 1331**, 20 suites, exit 0.
- `test-donor-league.js` 72 → 86. The shape check is now the v3 card list, `ranking` has five
  keys, and the `current_percent` asserts moved to `pct_max`. A new banner block checks:
  - default 5 slots: ranks 1–5 carry the exact `{url,width,height}`, and ranks 6 and 7 are null
    although their banners are approved;
  - the past strip is null;
  - slots 1, 7 (the boundary card) and 0 (no card anywhere);
  - 99 bounded to 5, and a raw `ds` with junk `bannerSlots` reading 5;
  - pending, rejected, removed, a traversal filename and zero width are all null on top-5 cards,
    with no pending bytes, reason text or `/uploads/` path anywhere in the response;
  - expiry hides a banner, and expiry 0 = never.
- `test-public-leakage.js` 87 → 94, §9:
  - the card builder's `inSlot` guard, verbatim;
  - `slots = bannerSlots(ds)`, and past cards built with rank null;
  - no `current_percent` in the card;
  - `donate.html` carries no v1 copy (`yourbrandname` / `ceremony` / "go through donate0" /
    `censored`) and no `current_percent`;
  - `donate.html` renders an image only through `bannerOf()` with the exact regex, as its single
    `<img>`;
  - names and `alt` go through `escHtml`.

Also run once, not kept in the repo: a **390 px iframe probe**, as in the v1 method (impl §10.3
*Part 4*). It used a throwaway Node server on 127.0.0.1 with stubbed `/api/*`, generated PNG
banners at 4:1, 8:1, 2:1, 320×80 and 1200×300, and headless Edge with `--screenshot`. The page
POSTed its measurements back, because Edge on Windows has no stdout for `--dump-dom`. The server
and every headless Edge process were killed in-session.
- **Fixtures:** 0 banners, 1 banner (8:1), 5 banners, slots 0, and a hostile set (an
  `<img onerror>` name, a `javascript:` banner URL, a `..` URL, zero width).
- **At 390 px, both the Reactor (dark) and Light themes:** `docWidth` 375 (= 390 − scrollbar)
  and **0 elements past the right edge** in all five fixtures. Every banner loaded into a 291×73
  box. The hostile fixture rendered the name as text, with no `<img>` and no `onerror` attribute.
  The D-01b slot, expiry and contact lines followed the fixture.
- **At 1280 px, dark:** 0 overflow. Rank 1's box is 1064×266 and ranks 2–5 sit four across at
  242×61.
- Both theme screenshots were read by eye, and the ink is legible in each.

#### §18 Part 5 — account page: donation row, rig badges, Donor profile panel (2026-09-24, uncommitted)

**The page (`public_html/account-settings.html`).**
- **P-05 donation row** (`renderDonationRow`). It reads `donation`:
  - With a tagged rig online: *"10 % of new earnings from 2 of 5 rigs online"*. Mixed tags show a
    range (*"5–20 %"*).
  - The second line names the donating rigs, with each rig's % when they differ (six names, then
    *"+N more"*).
  - An address that has donated before (`donor_profile.eligible`) but has no tagged rig online
    reads *"paused — no tagged rig online"*. Anyone else sees no row.
  - The tooltip states the per-rig rule and "rename + restart". The v1 ceremony text is deleted.
  - A *"Donor profile ↓"* link jumps to P-09 while it is visible.
- **P-03 badge.** A *"donates 10 %"* tag sits beside each rig whose `donate_percent` is above 0
  (`donateBadge`). Both workers windows are merged by name, as before.
- **NEW P-09 Donor profile** (`renderDonor`, from `donor_profile`):
  - **A lead line** for each refusal: donations off, blocked, or *"Donate from any rig to
    unlock"*. An eligible donor gets the intro, which says the reason for a refusal is shown on
    this (public) page.
  - **A two-proof gate.** It uses its own `dp-ip-proof` / `dp-pass-proof` inputs, restating the
    Goblin card's labels and help for this purpose.
  - **Two columns, name | banner**, each with state lines: showing, expired, waiting for review
    (+ UTC time), not approved (+ reason), taken off by the pool (+ reason), or none. Then the
    form and the Submit / Withdraw / Remove buttons.
  - **The banner column** also shows the approved banner in the wall's 4:1 box, through the
    exact-shape URL fence `DP_BANNER_URL_RE`. It says *"Showing — #2, inside the top 5"*,
    *"#8 — shows while you're in the top 5"*, *"not ranked in the donor league right now"*, or
    that banners are switched off.
- **Banner upload.** Picking a file does this in order:
  1. Size check (300 KB), which blocks.
  2. Magic-byte sniff of the first 16 bytes, the same three signatures as `SNIFFERS`, which
     blocks.
  3. A `data:` URL preview in the same 4:1 box, with the header dims as a **warning only**.

  It is sent as multipart, with the two proofs as text fields and the file named `banner`.
- **Pending content** comes only from the POST response, kept in the tab (`dpMine`) while
  `pending_at` still equals its `submitted_at`. After a reload the page shows the time only.
- **Removing a live item** arms on the first click (6 s) and acts on the second. Withdrawing
  a pending request is one click.
- **Errors** are the server's `error` sentences. The terse proof codes, including `wrong_kind`
  (the right proof in the wrong box — `match` until the Part 6 review renamed it), map to
  sentences in `DP_REASONS`, so no raw code is shown.
- **After a success** the page re-reads only the summary (`dpRefresh`) and clears both proof
  boxes. `dpReset` clears proofs, file, messages and pending text when the address changes or
  the demo loads.
- **DEMO**: `ipollo-01-donate10` (badge + "1 of 2 rigs"), an approved name, and a banner waiting
  for review at rank 3 of 5.

**Backend (`index.js`).** The account route drops `donation_percent`, `donor_name` and
`donor_name_state`, along with the `donor` helper that derived the pair; the api-docs row follows.
Nothing else changed. The miner routes and `profileFor` already carried every field §18.6/§18.8
need.

**Tests.** `npm test` **1331 → 1343**, 20 suites, exit 0.
- `test-donor-profiles.js` 182 → 187. The page's `DP_NAME` / `DP_BANNER` equal the lib's
  `NAME_MIN` / `NAME_MAX` / `NAME_CHARSET_RE` / `BANNER` / `MAX_BANNER_BYTES`. The page's own
  `dpCheckName`, evaluated from its source, agrees with `validateName` over a 19-name matrix
  (NBSP, RTL override, emoji, tabs, 32/33 chars, separators only) and sends the same normalised
  name.
- `test-public-leakage.js` 94 → 101. The account route sends `donation` + `donor_profile` and no
  v1 alias, and the api-docs row drops them. The page:
  - has no v1 copy and reads no dropped alias;
  - shows a live banner only through the exact-shape regex;
  - builds previews with `readAsDataURL` (`createObjectURL` only in the proof download);
  - clears both proof boxes on all three success paths;
  - never reads a pending name from the API.

Also run once, not kept in the repo: a **390 px iframe probe** with the Part 4 method. It used a
throwaway Node server on 127.0.0.1 that exits by itself, stubbed `/api/*`, a generated 1600×200
(8:1) PNG, and headless Edge with `--screenshot`. The measurements were POSTed back. Nothing was
left running afterwards (process sweep).
- **Fixtures:**
  - **A**: eligible, name showing, a rejected rename whose reason carries an
    `<img onerror>`, an approved 8:1 banner showing at #2 of 5, and mixed 5–20 % tags from 3 of 5
    rigs with long names.
  - **B**: never donated.
  - **C**: blocked and paused, name expired with a rename pending, banner removed by the pool with
    a long reason.
  - **D**: the built-in demo.
- **Reactor (dark) and Light, all four:** `docWidth` 375 and **0 elements past the right edge**.
  Each fixture showed the intended buttons and forms: B has no body, and C offers only
  Withdraw/Remove. The 8:1 banner letterboxed in a 311×76 box. The hostile reason rendered as
  text: no `<img>` in the panel, and no script ran. Screenshots of A-light and C-dark were read by
  eye, and the ink is legible.
- A copy tweak after the probe removed the doubled "not approved" wording. That changes text
  only, and `npm test` was re-run after it.

#### §18 Part 6 — independent review (2026-09-24, uncommitted)

A separate cold session read §18 and the working-tree diff, answered every §18.9 point with
evidence, and ran three one-shot scratch harnesses outside the repo (a per-share distribution on a
stub DB with the reconciliation invariant, a banner-parser fuzz, and the route inventory). The
answers and findings are in design §18.11 *Part 6*. What it changed:

- **One fix: `wrong_kind`.** `requireBothProofs` refused a proof that verified as the *other*
  kind with the verifier's own success code, `match`. So both the response and the
  `auditOwnerProof` row read `ok:false, reason:'match'`. The code is now `wrong_kind`, on the
  donor routes and the Goblin route alike. The refusal **text** did not change, so the Goblin
  strings stay byte-identical. The account page's `DP_REASONS` key was renamed to match.
- **Tests first.** `test-donor-profiles.js` gained two checks, one for the gate and one for the
  page map. Both failed before the edit and pass after it. `npm test` **1343 → 1345**, 20
  suites, exit 0. `bash -n scripts/07_grin_mining_public_pool.sh` OK.

### 10.7 Operator-selectable chain explorer — `branding.explorer_mainnet` (2026-09-24, add-ons — NOT VPS-tested)

**Origin:** every block height, block hash, kernel and output the pool shows links out to a public
Grin explorer. That link is the miner's independent proof. Until 2026-09-23 the explorer was
hardcoded (`DEFAULT_EXPLORER` in two browser files, plus `explorerBlockUrl()` in `index.js`). That
day the mainnet default moved from `scan.grin.money` to `grincoin.org`, which took a code edit in
three places. The explorer is now an **admin setting**, so a dead explorer can be swapped from the
panel. The work ran as backend, frontend, a cold review and this docs fold. **None of it has run
on a VPS.**

#### The setting

- **Settings → Branding → Chain Explorer**, `<select id="explorer_mainnet">`, stored as
  `branding.explorer_mainnet`. It is an **enum of exactly three keys, default `grincoin`**:

  | Key | Host | block (height) | block (hash) | kernel | output |
  |---|---|---|---|---|---|
  | `grincoin` (default) | `https://grincoin.org` | `/block/<h>` | `/hash/<hash>` | `/kernel/<ex>` | `/output/<c>` (unspent only) |
  | `tiny` | `https://scan.grin.money` (06d) | `/block/<h>` | `/block/<hash>` | `/kernel/<ex>` | `/output/<c>` |
  | `grinscan` | `https://grinscan.org` (06b) | `/block.html?h=<h>` | `/block.html?h=<hash>` | `/kernel.html?ex=<ex>` | `/output.html?c=<c>` |

- **Testnet is fixed** on `https://test.grinscan.org` (query style, key `grinscan_testnet`) and
  ignores the setting. Only grinscan has a usable testnet explorer: `testnet.grincoin.org` is
  pruned, so old blocks fail there, and `testnet.grinscan.org` is NXDOMAIN. On a testnet pool the
  select is greyed out, and the help line changes to say every link opens test.grinscan.org.
  `grinscan_testnet` is deliberately **not** a mainnet choice.
- **Validation** (`validateMainnetChoice`, wired into `lib/pool-settings.js` `validators.branding`)
  is an exact match: no trim and no case folding, so `' grincoin'`, `'GRINCOIN'`, a URL or a
  non-string is refused with a readable error, and the whole section save rolls back. `branding`
  is not a step-up section, so no second factor is needed. The save writes the ordinary
  `update_settings` audit row. Like every settings save, that row lists `changed_keys` (names
  only, never the old → new values, audit §J1-2), so a reader sees *that* `explorer_mainnet`
  changed but not to what.

#### How a key becomes a link

1. **One server registry, `back-end-pool/lib/explorers.js`** (new, pure, frozen): `STYLES`
   (`path` / `grincoin` / `query`), `EXPLORERS`, `MAINNET_CHOICES`, `DEFAULT_MAINNET`, `TESTNET`,
   `resolveExplorerKey(network, stored)` and `explorerUrl(key, kind, value)`.
2. **The server publishes the RESOLVED key, never the raw setting.**
   `resolveExplorerKey` returns `grinscan_testnet` on testnet. On mainnet it returns the stored
   value only if it is a string that `MAINNET_CHOICES.includes()`; otherwise it returns
   `grincoin`. That covers unset, `''`, a corrupt DB row, `__proto__` / `constructor`, and
   `grinscan_testnet`. The resolved key goes out as `explorer` beside `network` on the three
   routes that prime a page's network cache:
   - `GET /api/public/branding` → `connection.explorer`, which `branding.js apply()` reads.
   - `GET /api/pool/stats` → `explorer`, which admin-shell `decoratePoolIdentity()` reads.
   - `GET /api/config/pool-info` → `explorer`, which public `blocks.html` reads before its first render.

   `buildPublicConfig()` also publishes `branding.explorer_mainnet`, again resolved as mainnet:
   that is the operator's choice as made, and on a testnet pool it differs from
   `connection.explorer`. **Links follow `connection.explorer`.** All three routes' `API_DOC_META`
   rows describe the new key.
3. **Two browser mirrors of the registry**, `public_html/js/branding.js` and
   `admin-panel/admin-shell.js`, each back `window.Explorer`
   (`url` / `link` / `network` / `key` / `relink`). A primer caches the key in
   `sessionStorage['pool-explorer']` next to `'pool-network'`, and removes it when a response
   carries no key. `explorerKey()` **re-applies the resolve rule on the client**:
   - testnet → `grinscan_testnet`, whatever is cached, so a stale mainnet key from another tab
     can't leak onto a testnet pool;
   - otherwise the cached key if it is in `MAINNET_CHOICES` and is an own registry entry, else
     `grincoin`;
   - a `sessionStorage` that throws (private mode) also gives the network default.

   A key is only ever looked up in the registry. A published value is never used as a URL, so a
   path style always travels with its host.
4. **`/api/admin/blocks`** builds `grinscan_url` through `explorers.explorerUrl`. The field name
   is legacy and kept for API shape; it holds whichever explorer the setting resolves to.

**Link sites** (all through `Explorer.link`, which `xEsc`-escapes URL and label, adds
`rel="noopener"`, and `encodeURIComponent`s the value):
- public: `blocks.html` height + *view* column, `reactor-dashboard.js` `#height` and the tip,
  the `fortune-board.html` seed cell, `account-settings.html` ledger block rows and the
  withdrawal *Proof* column;
- admin: `blocks.html` and `health.html`.

#### Review fix — links rendered before the primer lands (Part 3)

A page's own fetch can beat its primer. Examples: branding's fetch against reactor-dashboard's
`loadStatus`, fortune-board's winners and the account ledger, or `decoratePoolIdentity` against
every admin page's fetch. `sessionStorage` is per **tab**, so every new tab counts as a first
visit. Those early links took the `mainnet` + `grincoin` fallback, and nothing re-rendered them.
On a testnet pool that meant test heights opened on grincoin.org (mainnet), and a mainnet pool
set to `tiny` or `grinscan` showed grincoin links anyway.

**Fix:** `link()` tags each anchor with `data-xp-kind` / `data-xp-ref`, and both primers call
`Explorer.relink()`, which re-points every tagged anchor through `explorerUrl()`. The host still
comes from the registry and the ref is re-encoded, so an attribute value never becomes the URL.
The review also corrected the plan's acceptance step, which expected old → new values in the
audit row. It records key names only, deliberately (above).

#### Propagation delay after a save

The server memo is dropped at once: the settings save and restore routes both call
`invalidateBranding()`. `/api/public/branding` is still served with `Cache-Control: public,
max-age=60`, and the primers rewrite `sessionStorage` on every page load. So an open browser
switches explorer on its **next page load after up to ~60 s**, and a hard refresh switches it
sooner. Operators should expect a delay of about a minute. It is not a bug.

#### Decided against

- **A free-text URL.** The three sites use different path schemes, so a typed host would bring
  back the 2026-07-25 bug where every grinscan link 404'd. A compromised admin panel could also
  point every miner's proof link at a fake explorer that confirms whatever the pool claims.
- **A "test this explorer" button.** grincoin.org answers HTTP 200 for every path, its error
  page included, so a status probe would call a dead explorer healthy.
- **Accepted caveat:** on 2026-07-25 `scan.grin.money` and `grinscan.org` resolved to the same
  Cloudflare IP and the same Express origin. If both still run on the operator's VPS, `tiny` and
  `grinscan` fail together, and the default `grincoin` is the independent choice.

#### Tests

`scripts/test-explorers.js` (new, last in `test:unit`) runs **198 checks**. They cover:
- every key × kind URL, including grincoin hash → `/hash/`, and URL-encoding of `1/../x` and `"<>`;
- `resolveExplorerKey` against every junk and prototype value;
- the validator;
- a `PoolSettings` round-trip on a throwaway SQLite file: default, the audit row naming the
  key, rollback on a refused value, a corrupt row still publishing `grincoin`, and Restore
  Defaults;
- the three routes publishing the resolved key, and `explorer_mainnet` not being step-up;
- **registry parity**: the `EXPLORERS` / `STYLES` / `MAINNET_CHOICES` literals in both browser
  files must equal `lib/explorers.js`, and `window.Explorer.url()` in each must equal
  `explorerUrl()` for every network × cached key (garbage, prototype keys, a stale mainnet key
  on testnet, a throwing `sessionStorage`);
- the three primers;
- the Branding select: exactly three options, and greyed out on testnet whether the network was
  already known or arrives later;
- the relink fix.

⚠ **Change a base or a segment in one of the three registry copies and this suite fails, so
change all three together.** On 2026-09-24, `npm test` exited 0 with `test-explorers.js` at
198/198.

**VPS acceptance is still owed.** Run testnet first, then mainnet: the select disabled on testnet
while Branding still saves; each of the three keys producing working block and kernel links on
mainnet, judged by page content and not by status code; the admin Blocks *view* column following
the setting; and a tampered DB row falling back to grincoin.org.

### 10.8 Tor payout hardening — F1–F5 + the exit-0 fallback (2026-09-25, add-ons — NOT VPS-tested)

**Origin.** On 2026-09-24 the operator asked: "Tor is unstable, how do we protect the wallet and
avoid double-spend?" A read-only review of the Tor payout path found that the existing rule
already holds: **never refund and never re-send unless the wallet proves the earlier attempt is
absent; if the answer is unknown, park the payout and keep the amount locked.** It also found five
gaps (F1–F5), and the operator approved all five on 2026-09-25. Building F5's design turned up a
sixth, worse gap in the shipped CLI rail. Another session fixed that one the same day.

Everything here is in the `add-ons` working tree, **uncommitted**, and **has never run on a
VPS**. Two steps are still owed: an independent review of the whole change, and VPS acceptance,
testnet first and then mainnet.

| # | Gap | Fix | Where |
|---|---|---|---|
| F1 | The kernel link and "paid · mined" could appear before the tx was mined | The kernel backfill stores a kernel only from a **confirmed** tx-log entry | `lib/withdrawal-scheduler.js` `backfillKernelProofs` |
| F2 | "Paid" meant the send command succeeded, and nothing watched for a tx that never mined | Watchdog: `payout_unmined` alert, admin `chain_state`, one safe CLI repost per hour | scheduler, `lib/wallet-tor.js` `repostTx`, `index.js`, `health.html`, `payments.html` |
| F3 | A pool-wallet shortfall waited 6 h or more and used up a retry | Shortfall retries after 1 h and does not count, capped at 24 | scheduler `scheduleRetry` |
| F4 | "Enable automatic payouts" and "Auto Payout Frequency" did nothing | Both keys and both inputs deleted | `lib/pool-settings.js`, `settings-payout.html` |
| — | **The CLI rail marked an undelivered Tor send PAID** (found by the F5 design) | Only `Tx sent successfully` counts as sent; the fallback slate is cancelled before the retry | `lib/wallet-tor.js` `classifySendOutput`, scheduler `_releaseTorFallback` |
| F5 | The Tor rail learned its slate id only after the send | Step-by-step Tor send through the Owner API, behind `tor_send_mode` (default `cli`) | `lib/wallet.js`, `lib/wallet-tor.js`, scheduler, `lib/db.js`, settings, `index.js` |

**Tests.** `npm test` was re-run while this section was written: exit 0, 21 suites. The five
suites this work touched stand at: `test-payout-guard.js` **220**, `test-payout-rails.js`
**122**, `test-admin-guards.js` **128**, `test-admin-panel.js` **105** and
`test-public-leakage.js` **108**. Each count matches the build sessions' own reports. The
build sessions also report that every new check was run against the code with its fix removed
and failed there. That claim is **theirs, not re-checked here**. Part 6 alone reports 35 such
mutations, each caught by at least one failure.

#### F1 — a kernel is stored only once the tx is seen mined

`backfillKernelProofs` copied `kernel_excess` from **any** tx-log entry that matched the row's
slate id. So a posted but unmined tx could light up "paid · mined" and an explorer kernel link
that opened a "not found" page. It now requires `t.confirmed === true`, as well as a slate id and
a kernel. The 3-minute throttle and the 30-day window are unchanged.

The build session settled which of two contradictory comments in the scheduler was right, by
reading the grin-wallet v5.4.1 source:

- The tx log's `kernel_excess` is written at **`tx_lock_outputs`**
  (`libwallet/src/internal/selection.rs` `lock_tx_context`). At that point it is the
  **sender-only partial excess**, not the final kernel.
- It is rewritten at **finalize** (`internal/tx.rs` `update_stored_tx`, called from
  `api_impl/foreign.rs` `finalize_tx` before `post_tx`).
- Confirmation (`internal/updater.rs`) never writes it.

So the comment "populated once the tx mines" was the wrong one, and a kernel in the tx log proves
nothing about the chain. Only `confirmed` does.

**The invariant later work relies on:** on a `confirmed` row, `kernel_excess IS NULL` means
"not yet seen mined", or that there is no slate id or no Owner API to ask. This holds only for rows
written after the fix. Rows filled earlier were left alone on purpose. The pool has run only on
testnet, so such a row could carry an unmined kernel, and the F2 watchdog cannot see it.

No API or UI text changed. `payment-history.html`'s "paid · sent" tooltip and the
`has_kernel_proof` descriptions were already literally true once the kernel means "confirmed".
Tests: `[kernel-proof]` in `test-payout-guard.js`.

#### F2 — the "marked paid but not mined" watchdog

A payout reaches `confirmed` when the send succeeds, not when the tx mines. A Grin node drops its
mempool on restart, so a posted tx can vanish. The miner then sees "paid" with nothing received,
and the pool wallet's inputs stay locked in an unconfirmed `TxSent`, which can itself cause a
shortfall. Reconciliation's `auditWalletSends` checks the **opposite** direction: a confirmed
wallet send with no pool row. The watchdog checks a pool row with no confirmed wallet send.

- **Where it runs.** In the scheduler loop, on the **same** `getTransactions(true)` call as the
  kernel backfill, under the same 3-minute throttle. It adds no node round trip, and it is
  read-mostly, so it runs while payouts are frozen.
- **Candidates.** Rows that are `confirmed`, have no kernel, were marked paid more than
  `UNMINED_ALERT_S` (3600 s) ago, and were created within 30 days. All three rails are covered.
- **Classes**, by the row's slate id in the tx log:

  | Tx log shows | `chain_state` | Alert level |
  |---|---|---|
  | confirmed | `mined` (once the kernel backfill stores the kernel) | — |
  | paid under an hour ago | `settling` | — |
  | `TxSent`, not confirmed | `unmined` | warning |
  | no slate id captured | `unverifiable` | warning |
  | `TxSentCancelled` | `cancelled` — the miner was debited and **not** paid | **critical** |
  | no entry for the slate | `absent` | **critical** |

- **The alert.** One rolling `alerts` row of type `payout_unmined`, updated in place while it is
  active and resolved by the first tick that finds nothing overdue. Its message lists withdrawal
  ids, slate ids and UTC ages, capped, with critical rows first. The data carries a short runbook.
  It is written through a new shared `_rollingAlert(type, level, message, data)`, which
  `_noteWalletShort` now uses too, with identical behaviour. The alert is stored in the DB only.
  **It is not pushed off-box:** AlertMonitor delivery is not wired (§J8-3).
- **The health card.** `/api/admin/health` folds the active alert into the Grin Wallet card. A
  warning downgrades an OK card to Degraded. A critical sets a new **`critical`** status, which
  `health.html` shows as a red **Critical** badge, because the service is up but wrong and must
  not read as "Down". An `error` (wallet down) is never masked.
- **Admin payments.** `GET /api/admin/withdrawals` adds `chain_state` per row. `payments.html`
  shows it as a badge beside "Paid", with a tooltip for each class. No public route carries it.
  `test-public-leakage.js` asserts this. `chainStateOf` reads the watchdog's last scan from
  memory, so for up to one tick after a restart an overdue row reads `unmined`. That is still
  literally true: the row is not yet *seen* mined.
- **The repost.** For the `unmined` class only, the pool re-broadcasts the **stored** finalized tx
  with the CLI, `grin-wallet repost -i <tx log id> -f` (`WalletTor.repostTx`). It does this at
  most once per row per hour (`REPOST_EVERY_S`), at most 3 rows per tick, and at most 24 times in
  a row's life. It is keyed on `repost:` event notes and skipped while payouts are frozen. It
  cannot pay twice: it is the identical transaction, with the same inputs and kernel, so the chain
  takes it at most once. It never builds a new tx, never cancels, never refunds and never changes
  a status. After 24 it stops and logs that a human is needed.
- **Why the CLI and not Owner v3.** The plan named `get_stored_tx → post_tx`. The build found that
  over JSON-RPC `get_stored_tx` returns a V4 slate with `sigs: []` (`api_impl/owner.rs` builds a
  blank slate that carries only `tx`), and `post_tx` rebuilds the kernel from `sigs` alone
  (`libwallet/src/slate.rs` `tx_from_slate_v4`). That route would post a zero kernel. The CLI
  keeps the slate in-process, and it refuses a tx that is confirmed or was never finalized
  (`controller/src/command.rs` `repost`). **So never round-trip a stored tx through JSON-RPC and
  post it.** `finalize_tx`'s own return value does carry the sigs and is fine.
- **No refund route was added.** For a `cancelled` or `absent` row, the operator checks the node,
  reposts, or, once the wallet proves the tx is gone, refunds by hand. Settling such a row
  automatically in either direction is exactly what the money rules forbid.

Tests: `[unmined]` in `test-payout-guard.js`. `test-admin-panel.js`'s STATUS-set regex was scoped
to its own block, because the new `CHAIN` map matched it.

#### F3 — a pool-wallet shortfall retries in 1 h and does not count

When grin-wallet refuses a Tor send with `NotEnoughFunds`, the cause is usually outputs held by
other payouts that are still settling, and it clears within the hour. It used to take the
miner-offline ladder (6/12/24/48 h) and use up a rung, so four shortfalls in a row reached
`markFailed` and refunded a payout that had never left.

- `scheduleRetry(id, 'pool_wallet_short')` now retries after `SHORTFALL_RETRY_S` (3600 s) with
  `retry_count` unchanged. This check runs **first**, before the ladder-exhausted test, so a
  shortfall on the last rung takes an uncounted retry instead of `markFailed`.
- The update is guarded (`WHERE status = ?`) and writes its event in the same transaction. The note
  reads `shortfall: pool wallet short, retry k/24 (not counted) at <ISO>`.
- The count is `COUNT(note LIKE 'shortfall:%')` over the row's whole life, cumulative and not
  consecutive. At `MAX_SHORTFALL_RETRIES` (24, about a day) the scheduler logs a `console.error`
  and falls through to the normal ladder. That consumes a rung and waits 6 h, and `retry_reason`
  stays `pool_wallet_short`. So a pool that is simply underfunded does not hold a miner's balance
  forever. The existing last-rung guard decides in the end.
- **The double-send guard is unchanged.** An uncounted retry is still a re-attempt, because
  `priorAttempts` comes from the event log. A test pins it: `retry_count` 0 and slate NULL, with an
  unconfirmed match, defers and does not send.
- **The admin retry route** zeroes `retry_count` but not the shortfall count in the event log. So
  a row re-queued by hand after using its 24 goes straight to the ladder on its next shortfall.
  That is by design: the operator re-queued a pool that is already known to be short.
- The miner's pending strip already reads "queued and will be retried automatically … · next
  attempt HH:MM". For a shortfall that time is now about an hour ahead.

Not fixed, and out of scope: `payout.withdrawal_retry_delays` is still shadowed (audit §J9-8).
Tests: the end of `[retry-reason]` in `test-payout-guard.js`.

#### F4 — the dead auto-payout settings are deleted

`payout.auto_payout` and `payout.payout_frequency` had inputs in admin → Payout, and nothing read
either one. Both inputs, both defaults and the `payout_frequency` validator were removed in **one**
change, exactly as D4 was: the harvester sends every id in `.settings-form`, and `updateSection`
throws on an unknown key. A removal comment sits in `defaults.payout`.

A pool that already stored either key keeps working. `getSection` still merges stored rows over
the defaults with no membership check. The save harvests only ids that are on the page, and
`populateForm` skips keys with no element. The stored rows stay, inert, with no migration.
`test-admin-guards.js` `[7]` proves this against a DB holding `auto_payout='true'` and
`payout_frequency='daily'`: the section loads, a save of the real form succeeds, no audit row
names either key, and sending either key now throws *Unknown key*. `test-admin-panel.js` `[10]`
pins the Payout form ↔ defaults parity. The only defaults with no field on the page are
`dormancy_policy_effective_at` and `withdrawal_retry_delays`.

#### The exit-0 slatepack fallback is no longer marked paid

The F5 design (design §8.1.1) found this in the grin-wallet source, and another session fixed it
the same day. `grin-wallet send -d grin1… -a N` **exits 0 when the Tor delivery fails**. It falls
back to a slatepack: it locks the outputs, writes `<wallet>/slatepack/<uuid>.S1.slatepack`, prints
the slatepack and returns `Ok`. That holds in both v5.4.1 and v5.5.0. The pool read exit 0 as
sent and called `markConfirmed`, so the miner was debited and received nothing, and the locked S1
held its inputs until someone cancelled it.

- `lib/wallet-tor.js` `classifySendOutput` returns `sent`, `slatepack_fallback` or
  `unrecognised`. Only the anchored `Tx sent successfully` line means sent, and it is tested
  **first**, so a posted tx is never classified as a fallback and cancelled.
- On a fallback, `sendToTorAddress` returns `success:false` with the slate id parsed from the
  `.S1.slatepack` path. `_releaseTorFallback` cancels exactly that slate before `scheduleRetry`.
  Cancelling is safe because only the sender finalizes. Without the cancel, the retry's
  double-send guard would read the locked `TxSent` as unconfirmed and defer forever.
- If there is no parsable id, or the cancel fails, nothing is guessed. The row parks and the guard
  defers it. Unrecognised exit-0 output counts as a failure and is never cancelled.

Tests: +12 in `test-payout-rails.js` and +11 in `test-payout-guard.js`. Audit roll-up note "Tor
rail marked a failed send paid".

#### F5 — step-by-step Tor send, behind `payout.tor_send_mode` (default `cli`)

The design and its failure matrix are **design §8.1**. It is now built as designed, with the
deviations listed below. With `tor_send_mode = cli`, which is the default, the CLI rail behaves
exactly as it did: `sendWithdrawal` was not edited by this part.

- **Switch.** `payout.tor_send_mode` is `cli` or `stepwise`. It is a `<select id="tor_send_mode">`
  in admin → Payout. The validator accepts those two values after trim and lowercase and throws on
  anything else. It is applied on a backend restart. `stepwise` without an Owner-API wallet runs
  `cli` and logs an error at start. Two config-only knobs, not admin settings:
  `tor_send_connect_timeout_ms` (30000) and `tor_send_receive_timeout_ms` (60000).
- **`lib/wallet.js`.** `init_send_tx`, `tx_lock_outputs`, `finalize_tx`, `post_tx` and
  `cancel_tx` now go out with **named** params. The Slatepack and Goblin rails share them, and
  their tests stayed green. `initSendTx` takes `paymentProofRecipient` and uses a 60 s per-call
  timeout (`_call(…, { timeoutMs })`; the default stays 10 s). `ttl_blocks` stays `null` **on
  purpose**: the wallet auto-cancels an unconfirmed past-TTL tx, posted ones included. New
  `withSendLock(fn)` is an in-process mutex. The Slatepack and Goblin create paths wrap their
  init → lock in it, so two in-process sends cannot select the same coins.
- **`lib/wallet-tor.js`.** `postJsonRpcOverSocket` generalises the probe's request.
  `checkVersionOverSocket` is now a thin wrapper around it with identical limits. `deliverSlate`
  runs `check_version` and requires Foreign API ≥ 2 and `V4`. It then sends `receive_tx` with
  params exactly `[S1, null, null]`, **positional by design**: it is the miner's Foreign API, and
  that is what the CLI sends. It returns `{ ok, slate }` or `{ ok:false, ourSide, requestWritten,
  reason, detail }`. One retry on a fresh circuit is allowed before `receive_tx` and never after.
- **`lib/db.js`.** Two new columns, `withdrawals.tor_step` and `withdrawals.tor_final_slate`,
  both `TEXT NULL` with a guarded ALTER. There are **no new statuses**: the row stays
  `tor_sending` for the whole attempt.
- **The scheduler.** `checkTorAndSend` dispatches to `sendWithdrawalStepwise` or `sendWithdrawal`.
  - The attempt walks `tor_step` through `claimed → initiated → locked → delivering → finalizing →
    posting`. Every move is a guarded write.
  - `slate_id`, the fee and a `slate: <uuid> created (stepwise)` event are written in one
    transaction **before** `tx_lock_outputs` and before any network I/O. The freeze is checked
    before delivery and before post.
  - `_stepwiseCancelThen` cancels **strictly before** any requeue or retry, and refuses to cancel a
    row at `posting`.
  - A delivery failure on the pool's own side (its tor is down) takes the new uncounted reason
    `pool_tor_unavailable`: 900 s, `tor-down:` notes, cap 24, then the ladder. It is the F3
    pattern.
  - The stale sweep gains a stepwise branch, `_reclaimStaleStepwise`. It re-posts a `posting` row
    at most once per 5 min (`stepwise: repost` notes, cap 24) and never while frozen. It parks a
    contradiction, meaning a `posting` slate that is cancelled or absent, behind a **critical**
    `payout_tor_stepwise` alert.
  - `_stepwiseReattemptGuard` looks up every journaled slate exactly before a new slate is created.
    It also runs `_priorSendLanded` when the row has CLI history.
  - Ids of live attempts sit in `_liveStepwise`, so the sweep never races one.
- **`index.js`.** `tor_final_slate` is stripped from `GET /api/admin/withdrawals` and
  `/api/admin/miners/:addr`, because it is a complete signed transaction. `tor_step` stays, since
  it tells the operator where a `tor_sending` row stopped. No public route changed, and
  `test-public-leakage.js` `[F5]` asserts that neither column appears on one.

**Deviations from design §8.1:**

- **(a)** A row counts as stepwise when its newest **claim** event is stepwise, that is, the newest
  move into `tor_sending` from another status. It is not the newest `to_status='tor_sending'`
  event. Progress events are journaled `tor_sending → tor_sending`, and a `slate:` note would
  otherwise hide the marker.
- **(b)** For the same reason, the stale sweep's age counts claim events only. That gives the same
  result for CLI rows. Without it, every repost pushed the next sweep 10 min out and masked the
  5-minute re-post rate.
- **(c)** The sweep requeues a pre-`posting` row **without** a cancel when the tx log already shows
  its slate as `TxSentCancelled` or absent. `cancel_tx` errors forever on those. This is the case
  where the process crashed between the cancel and the requeue.
- **(d)** An unreadable tx log before a stepwise re-attempt **defers**. On the same condition the
  CLI rail proceeds, loudly.
- **(e)** and **(f)** are test and route plumbing: payout-rails `d. (retry)` now uses
  `retrievePaymentProof`, and the admin list keeps its `const { payment_proof, ...rest }` line and
  deletes `tor_final_slate` from `rest`.

**Journal lines for one stepwise payout, in order:**
`[tor-stepwise] withdrawal N: step claimed` → `step initiated — slate <uuid> saved, locking
outputs` → `step locked` → `step delivering` → `step finalizing` → `step posting` → `posted —
slate <uuid>`. If the backend stops after `step locked`, then after a restart plus about 10 min the
sweep logs `stale withdrawal N: …` and puts the row back to `tor_checking`. `grin-wallet txs`
then shows that slate as `TxSentCancelled`, and the next attempt creates a **new** slate.

Tests: `[stepwise]` S1–S16 in `test-payout-guard.js`, and a named-params wire section plus
`[stepwise-transport]` T1–T9 in `test-payout-rails.js`. The transport tests use an in-process fake
SOCKS5 server and a fake Foreign API on `127.0.0.1:0`, closed in `finally`. Also
`test-admin-guards.js` `[8]` (the validator and `applyToConfig`), `test-admin-panel.js` `[10]`
(the select) and `test-public-leakage.js` `[F5]`.

#### Markers and alert types that code keys on

| Kind | Value | Written by | Read by |
|---|---|---|---|
| event-note prefix | `deferred:` | double-send guard deferral (pre-existing) | the unreadable-log path |
| event-note prefix | `shortfall:` | F3 uncounted shortfall retry | the 24-cap count |
| event-note prefix | `tor-down:` | F5 uncounted `pool_tor_unavailable` retry | the 24-cap count |
| event-note prefix | `repost:` | F2 CLI repost | once per hour, 24-cap |
| event-note prefix | `stepwise:` | F5 claim, requeue, post, `stepwise: repost` | stepwise detection, the 5-min re-post rate |
| event-note prefix | `slate: <uuid>` | F5 step 2 | the §8.1.5 re-attempt guard; `_dropStepwiseSlate` (review fix 1) |
| `retry_reason` | `pool_wallet_short`, `pool_tor_unavailable` | `scheduleRetry` | the account page; only `pool_wallet_short` has its own wording |
| `alerts.type` | `pool_wallet_short` (warning) | `_noteWalletShort` | health, Grin Wallet card |
| `alerts.type` | `payout_unmined` (warning / critical) | F2 watchdog | health, Grin Wallet card |
| `alerts.type` | `payout_tor_stepwise` (warning / critical) | F5 stale sweep | **not** on the health card yet; the alerts list only |

Renaming any prefix silently resets a cap or hides a row from the sweep. Grep before changing one.
The review's `cli: cleared stepwise slate …` note is written for the operator and read by nothing.

#### Independent review (2026-09-25) — two fixes, five test gaps closed

A review of Parts 1–6 re-read the diff and reverted each guard in a scratch copy to see whether a
test caught it. It found two bugs. Both had a failing test before the fix. Both fixes are in
`checkTorAndSend`, and `sendWithdrawal` is not edited.

1. **A double pay after switching `tor_send_mode` back to `cli`.** The stepwise rail writes
   `slate_id` before its lock, and a cancelled stepwise slate stays in that column while the row
   waits on the ladder. The CLI rail reads a non-null `slate_id` as this payout's own send. Its
   double-send guard, `markFailed` and the stale sweep therefore looked up only that dead slate,
   found it `absent`, and sent again or refunded. That happened even when an earlier CLI attempt
   (killed at the timeout after it posted) had landed. `_captureTorSlateId` also never overwrote
   the column, so the kernel backfill and the watchdog kept watching the cancelled slate and
   raised a false critical "NOT paid" alert, whose runbook says "credit the balance back or pay
   again". **Fix:** `_dropStepwiseSlate` clears `slate_id` right before a CLI attempt, but only
   when the row's own journal names it as a stepwise slate. It writes a `cli:` event. Before F5 a
   CLI row had no `slate_id` until it settled, so this restores that state. The `slate:` journal
   line stays, so a switch back to stepwise still finds the slate.
2. **A freeze did not stop the rest of a batch that was already running.** The loop checks the
   freeze once per tick. One tick can run up to 10 retries and 5 checks back to back, each up to
   `wallet_send_timeout_ms`, and AlertMonitor freezes on its own timer. **Fix:** the CLI branch
   of `checkTorAndSend` re-reads the freeze for each row. The stepwise rail already checked at its
   claim. The row waits in `tor_checking` and goes out after a resume.

Tests that could not fail before now can: F2's `MAX_REPOSTS` cap (the old case was stopped by the
hourly rate instead) and `REPOST_MAX_PER_TICK`; F5's refusal to cancel a `posting` row (no current
path reaches it, so it is pinned directly), `MAX_STEPWISE_REPOSTS`, and the claim-only stale age.
New cases are `[stepwise]` S17–S19 and `[review]` R1–R5 in `test-payout-guard.js`, which went from
220 to 233 checks. Each was shown to fail with its guard removed. `npm test` exits 0, and every
other suite is unchanged.

#### Still open

- **VPS acceptance.** Nothing above has run on a box.
  The acceptance runs a normal Tor payout (kernel only after `confirmed`), a dropped tx (restart
  the node before it mines), a shortfall, the Payout save on a pool that stored the old keys,
  stepwise end to end with `verify_proof`, a backend stop between lock and delivery, and the
  exit-0 case (a wallet that goes offline between the pre-flight probe and the send). Stepwise
  stays testnet-only until the operator decides otherwise.
- **The watchdog's fallback class.** The recommended watchdog class for a `Standard1` tx (locked,
  never finalized, readable from `tx_slate_state` on v5.5.0 only) was **not built**. The send-side
  fix makes new fallback rows unlikely, but a row paid before it, or one whose cancel failed,
  still reads `unmined` (a warning), and its repost fails every hour until the 24-repost cap.
  **Check the testnet DB now** for `confirmed` Tor rows whose tx-log entry is an unconfirmed
  `TxSent`. Each one is a miner who was not paid.
- **Stepwise payment proof.** The review corrected the comment above `backfillPaymentProofs`: a
  stepwise row requests a proof too. The backfill's `method = 'tor'` query picks it up, but no
  test covers a stepwise proof. Acceptance step 5a (`verify_proof`) is the only check.
- **Seen in review, not fixed.** These are listed in the plan's Part 8 row:
  - `pool_tor_unavailable` shows the miner "wallet unreachable". The wording needs an operator
    decision.
  - The admin cancel route refunds a deferred `retry_scheduled` row with no wallet check. This
    predates this work.
  - `withSendLock` does not cover the CLI rail, which runs as a second process.
  - Reconciliation's unrecorded-send audit leaves out `retry_scheduled` rows. This predates this
    work.
- **Off-box delivery.** None of the three alert types is pushed off-box (§J8-3).
- `payout.withdrawal_retry_delays` is still shadowed, so a shorter ladder set in the DB would not
  apply (§J9-8).
- `max_pending_withdrawals` / `max_user_pending` have no validator. The first real save stores
  `'100'` as a string over the numeric default, and the audit row names both keys as changed
  although nothing moved. It was seen during F4 and left alone because it is out of scope.

---

## 11. Ports

The reference §5 and §8 point at. Mainnet and testnet are separated by PORT, not by box — every
row below has two values.

**Pool box (`singlebox` / `hub`)**

| Port | Mainnet | Testnet | Bind | What |
|---|---|---|---|---|
| Public stratum | 3333 | 13333 | `0.0.0.0` | miners. Raw stratum only — a PROXY-v2 header is never accepted here |
| Central API | 8080 | 8090 | `127.0.0.1` | Express backend; reached from outside only through the nginx vhost |
| HTTPS | 443 | 443 | `0.0.0.0` | nginx (static site + `/api/*` proxy) |
| Node built-in stratum (upstream) | 3416 | 13416 | `127.0.0.1` | grin's own `stratum_server_addr` default — the toolkit does **not** move it |
| Node API (foreign/owner) | 3413 | 13413 | `127.0.0.1` | wallet → node |
| Wallet combined listener | 3420 | 13420 | `127.0.0.1` | `owner_api` + `include_foreign`; ECDH auto-unlock. `:3415`/`:13415` is retired (kept only as `api_listen_port` in `grin-wallet.toml`) |
| Region stratum listeners | 3391, 3392, … | 13391, 13392, … | `region_listen_host` (the wg server IP) | one per regional gateway; region is stamped from the listener |
| WireGuard | 51820/udp (`wg-grinpool`) | 51821/udp (`wg-grinpool-tn`) | `0.0.0.0` | only when multi-region is enabled |

Tunnel nets: `10.66.66.0/24` (mainnet) / `10.66.67.0/24` (testnet); hub `.1`, gateways `.2`, `.3`, …

**Gateway box**

| Port | Value | Bind | What |
|---|---|---|---|
| Public stratum | 3333 (`public_stratum_port`) | `0.0.0.0` | miners; HAProxy `mode tcp` + `send-proxy-v2`, stick-table conn-rate limit |
| WireGuard | ephemeral → the hub's 51820 (mainnet) / 51821 (testnet) udp | — | local iface is always `wg-grinpool` |
| Latency probe (optional) | 443/tcp | `0.0.0.0` (IPv4) | only after `6) Latency probe` → enable: `grin-gateway-probe`, a separate HAProxy answering `GET /ping` with 204 and 404 to anything else (§8.7) |
| certbot HTTP-01 (optional) | 80/tcp | `0.0.0.0` | opened in the firewall with the probe, but **bound only for the seconds of an issue/renewal** (certbot standalone); nothing listens otherwise |

A gateway box runs **nothing else** — no node, no wallet, no DB, no Node.js. Its only HTTP
listener is the optional latency probe above, which has no backend and serves no data.

The hub's `/ping` (204, for the same measurement) rides its existing nginx `:443`.

**One mining role per box.** A brain and a gateway both bind :3333, so `pool_mode_conflict_check`
refuses to install one where the other (or a legacy satellite) already exists. Mainnet and testnet
*pools* can share a box; solo mining cannot share with either.
