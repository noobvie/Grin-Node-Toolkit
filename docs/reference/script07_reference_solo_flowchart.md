# Script 07 — Solo Private Pool Flowchart (Reference)

> **Covers code as of:** 2026-07-06 (the flowchart's own stamp)
> **Last verified:** never systematically verified (the Code layout section was checked against the split files 2026-10-18; the flowchart itself was not; the "Node binary change marker" section's references were read against `add-ons` at `cdbf2d2` on 2026-10-28, when it was written as a design, and re-read by a separate design review the same day)
> **Product code last changed:** 2026-10-04 (`a6b0e1b`: planned-stop marker before the stratum-config restart in `07_grin_mining_solo.sh`)
> Prose last edited 2026-10-12 (moved out of `script07_design.md`, where it was the closing appendix; text unchanged).
> Code layout section added 2026-10-18 (script split into entry + 3 libs; flowchart text unchanged).
> "Node binary change marker" section added 2026-10-28 as a design; built and updated to the as-built hint wording and window-day edge the same day (uncommitted, not VPS-tested).

**Product:** `scripts/07_grin_mining_solo.sh` — solo private mining (separate from the public pool,
[`script07_design.md`](script07_design.md)).

---

## Code layout

`07_grin_mining_solo.sh` is the entry and keeps its path. Menu sections live in sourced libs under
`scripts/lib/`; every function kept its name.

| File | Menu | Purpose |
|---|---|---|
| `07_grin_mining_solo.sh` | main, network, `lan` arg | header, logging, node/toml discovery, IP detection, status/precheck, live stats, menus, `solo_deploy_code`, settlement, `main` |
| `lib/07_solo_stratum.sh` | network menu `2` Stratum; top `5` Watchdogs (stratum watchdog) | setup & publish, manual config, restrict, stratum watchdog cron |
| `lib/07_solo_stats_page.sh` | top `3` | `solo_deploy_stats_page`: stats vhost, access lock, payout split, page deploy |
| `lib/07_solo_cleanup.sh` | top `C` | `solo_cleanup`: full cleanup (destructive, kept apart) |
| `lib/07_solo_wallet.sh`, `07_solo_backup.sh`, `07_solo_quiet.sh` | wallet · backup · quiet hours | unchanged |

- **Source order:** the three new libs are sourced directly after `07_solo_quiet.sh`, unconditionally
  (a missing lib must fail loudly), and before `main "$@"`. Their only top-level lines are literal
  globals (`STRATUM_WATCHDOG_*`, `_ACCESS_*`), so they cannot fail at source time under the entry's
  `set -euo pipefail`. Helpers used by more than one lib (`graceful_restart_grin`, the IP detection
  block) stay in the entry.
- **errexit:** every dispatch is `fn || true`, so a lib function runs with errexit off whatever the
  entry sets; file operations in the libs are not individually guarded.

---

## Solo private pool flowchart

Merged from `flowcharts/script07_mining_solo_flow_chart.txt` on 2026-07-09.

```text
================================================================================
 07_grin_mining_solo.sh — Solo Private Pool Flowchart   [current as of 2026-07-06]
================================================================================

 Configure & manage solo mining on a Grin node: enable the node's built-in
 stratum, set the coinbase wallet, publish the port, and (optionally) run a
 combined coinbase wallet listener, a stats web page, watchdogs, and a payout
 split for a trusted group.

 Launch:  grin-node-toolkit → 07 Mining hub → Solo private pool
          Optional arg:  07_grin_mining_solo.sh lan   → LAN stats-page mode
          (SOLO_NET_MODE = "public" default | "lan"; only the stats page differs —
           every mining mechanic is identical in both modes.)

 MENU MODEL — network-as-parent (mirrors 059 Grin Drop)
   The top screen picks a network ONCE (1/2); inside that branch SOLO_NETWORK is
   set and inherited, so per-action network prompts are gone. Cross-network tools
   (both-net status, the unified stats page, global watchdogs, maintenance,
   payouts) live on the top screen, not inside a branch. All-numeric keys for
   main actions; letters (A / C) for guided-start and destructive/admin.

 Entry
   └─> main("$1")               $1 == "lan" → SOLO_NET_MODE=lan
         ├─> direct-launch mode guard (skip when SOLO_LAUNCHED_VIA_HUB set):
         │     warn if a deployed stats vhost's mode ≠ the launched mode
         └─> loop: show_menu()  ← network-select screen, loops until 0

  ┌─────────────────────────────────────────────────────────────────────────┐
  │  TOP MENU — Network-select screen  (show_menu / main dispatch)          │
  └─────────────────────────────────────────────────────────────────────────┘
   Header shows show_compact_status(): per-net Node RUNNING/OFF (ss only, no API
   call) + Stratum LISTENING/OFF + bind PUBLIC/LOCAL.

   A) Start here — node check ............ solo_node_precheck()
   1) Configure solo pool Mainnet ........ _set_solo_net mainnet → solo_net_menu()
   2) Configure solo pool Testnet ........ _set_solo_net testnet → solo_net_menu()
   3) Deploy stats web page .............. solo_deploy_stats_page()   (both nets)
   4) Node, Wallet & Mining Status ....... show_node_status()        (both nets)
   5) Watchdogs (global) ................. watchdog_menu()
   6) Maintenance ........................ maintenance_menu()   (lib/07_solo_backup.sh)
   7) Payouts & settlement ............... solo_settlement_menu()     (mainnet)
   C) Clean up solo mining ............... solo_cleanup()   (Danger Zone)
   0) Back to main menu

  ┌─────────────────────────────────────────────────────────────────────────┐
  │  PER-NET BRANCH  (after 1/2 — SOLO_NETWORK set)   solo_net_menu()        │
  └─────────────────────────────────────────────────────────────────────────┘
   Header shows _show_node_info(net): Node / Wallet listener / Stratum / miners
   + toml enable/bind/wallet/burn for the chosen net.

     1) Wallet          ▸  wallet_menu()      (combined coinbase listener)
     2) Stratum         ▸  stratum_menu()     (setup&publish / config / restrict)
     3) Terminal Stats  →  solo_live_stats(net)   (live dashboard, this net)
     0) Back to network select

================================================================================
 A) START HERE — NODE PRE-CHECK   solo_node_precheck()
================================================================================
 Read-only "step 0": solo mining needs a fully-synced node on THIS server.
   ├─> _precheck_one_net(mainnet, 3413, primary)
   │     ├─> ss :3413 → RUNNING? else point at Script 01 (real mining needs it)
   │     └─> gnc_owner_get_status → sync_status / tip.height / connections
   │           no_sync → "✓ Ready to mine" ; *_sync → "⏳ still syncing, wait"
   ├─> _precheck_one_net(testnet, 13413, optional)  [same; "spin one up too"]
   ├─> _precheck_next_action → most-useful next step (mainnet priority)
   └─> can launch Script 01 in-process (build/sync a node without leaving 07)

================================================================================
 1) WALLET — Central coinbase listener   wallet_menu()   (lib/07_solo_wallet.sh)
================================================================================
 Runs the whole wallet flow inside Script 07: init/recover → save pass → patch
 toml → start ONE COMBINED Owner+Foreign listener that receives coinbase and stays
 alive across reboots/crashes. Dir: /opt/grin/solowallet/<net>/.

 Header: sw_listener_status (both nets) + sw_autostart_status + sw_watchdog_status.

   1) Setup / Recover ....... sw_setup(net)
        1. grin_wallet_install.sh → download + verify grin-wallet binary
        2. init (grin-wallet init -h)  OR  recover (init -hr from seed)
        3. _sw_read_new_pass → save passphrase to <dir>/.passphrase (chmod 600)
        4. patch grin-wallet.toml: node_api_secret_path → node's .foreign_api_secret
           + owner_api_include_foreign = true   (mount Foreign on the Owner port)
        5. grin_install_secret_sync → box-wide secret self-heal
        6. sw_port_collision_check, then start the combined listener
   2) Start listener ........ sw_listener_start(net)  → listen.sh in tmux
   3) Stop listener ......... sw_listener_stop(net)
   4) Show address .......... sw_show_address(net)   (grin-wallet -p … address)
   5) Enable boot autostart . sw_autostart_enable(net)   @reboot tag-guarded cron
   6) Disable boot autostart  sw_autostart_disable(net)
   7) Install listener watchdog  sw_watchdog_install    */5 relaunch if port down
   8) Remove listener watchdog   sw_watchdog_remove
   0) Back

 ─── COMBINED LISTENER — `-p owner_api`, and WHY NOT ECDH LIKE THE PUBLIC POOL ──
   The node funds coinbase via the wallet FOREIGN API (build_coinbase). Solo runs:
       grin-wallet <net_flag> -p <pass> owner_api   (owner_api_include_foreign=true)
         → Owner API + mounted Foreign API BOTH on 3420 / 13420
           (NOT the old bare-`listen` Foreign 3415 / 13415)
   · `-p` opens the wallet at startup, so the mounted Foreign build_coinbase works
     IMMEDIATELY — no unlock step. Verified testnet 2026-07-06 (CbData on 13420).
   · Launcher listen.sh reads the pass from .passphrase (not in the tmux argv),
     but the wallet process still shows `-p <pass>` in `ps aux` / /proc/cmdline.

   The public POOL runs the identical owner_api+include_foreign listener but DROPS
   `-p` and unlocks at runtime via an ECDH `open_wallet` helper (Owner API v3:
   init_secure_api → key exchange → open_wallet, keychain mask held in memory).
   Solo deliberately does NOT copy that:
     · ECDH open_wallet is an Owner-API SESSION op — it needs a persistent client
       to run the handshake and hold the mask. The pool already has one (its
       Node/Express backend). Solo has NO backend; adding a Node service JUST to
       unlock a wallet pulls in a dependency solo is designed to avoid.
     · `-p owner_api` reaches the SAME end state (wallet open, Foreign coinbase
       live) with a saved pass file and zero moving parts.
   TRADE-OFF: the saved-pass model exposes the passphrase in the listener's argv
   (same hot-wallet rationale the pool documents in script07_security_audit.md).
   grin-server.toml wallet_listener_url MUST be the BASE URL http://127.0.0.1:3420
   (node appends /v2/foreign itself; a stored /v2/foreign or old :3415 → no coinbase).

================================================================================
 2) STRATUM — enable + publish the node's built-in stratum   stratum_menu()
================================================================================
 Header: show_compact_status(). Setup and Publish are now ONE action.

   1) Setup & Publish ..... _stratum_dispatch setup <net> → _do_setup_stratum()
        find_grin_server_toml(net, api_port)  [running-PID → readlink → scan → prompt]
        ├─> enable_stratum_server = true
        ├─> wallet_listener_url = base URL (default http://127.0.0.1:3420, 13420 test)
        │     normalises legacy values: strips /v2/foreign, snaps old :3415/:13415
        │     → Owner port (combined listener), else node calls a dead port
        ├─> burn_reward = false  (forced — never prompt; can't burn real rewards)
        └─> flows into _enable_stratum():
              ├─> _show_stratum_port_guide → confirm
              ├─> stratum_server_addr = "0.0.0.0:<port>"
              ├─> firewall: 1) all IPs (ufw/iptables, -C guarded) · 2) one IP · 3) skip
              ├─> graceful_restart_grin(api_port, net)   [TERM→wait→tmux restart]
              ├─> print miner connect box: stratum+tcp://<public|LAN ip>:<port>
              │     + worker/login hint "<nickname>.rig1" (dot groups payout split)
              │     + Cloudflare "DNS only (grey cloud)" warning (public mode)
              └─> _solo_watch_for_miner → optionally tail for first miner connect
   2) Manual config ....... _do_configure_stratum()   single-field editor
        show fields 1-4 → pick one → sed patch → graceful_restart_grin
   3) Restrict ............ _disable_stratum()
        stratum_server_addr = "127.0.0.1:<port>" · ufw delete · graceful_restart_grin
   0) Back

================================================================================
 3) TERMINAL STATS   solo_live_stats(net)     (per-net branch ▸ 3)
================================================================================
 Live in-terminal dashboard (Enter = refresh, 0 = return).
   ├─> read .api_secret + .foreign_api_secret from /opt/grin/node/<net>-prune/
   └─> each refresh:
         ├─> curl 127.0.0.1:<api>/v2/owner get_status → height, total_difficulty, peers
         ├─> _solo_network_hashrate: two get_header (Foreign API) over a 60-block
         │     window → Cuckatoo32 GPS = diff_delta × 42 / dt / 16384 (G/s·kG/s·MG/s)
         └─> ss ESTAB on stratum port → miners connected

================================================================================
 3) DEPLOY STATS WEB PAGE   solo_deploy_stats_page()     (top menu ▸ 3)
================================================================================
 ONE unified static page (nginx) shows mainnet + testnet side by side. No Node.js,
 no DB, no systemd. nginx injects Basic Auth per network so the secret never
 reaches the browser. Public mode = domain + Let's Encrypt; LAN mode = plain HTTP.

   ├─> auto-detect nets: have_main/have_test from /opt/grin/node/<net>-prune/.api_secret
   │     (a missing net gets no proxy location → greys out on the page)
   ├─> nginx_install_with_certbot (install up front; bare node has no /etc/nginx)
   ├─> ADDRESS:
   │     LAN mode  → prompt LAN IP (_detect_lan_ipv4) + HTTP port (default 80)
   │     public    → Cloudflare/DNS note → prompt subdomain → nginx_validate_domain
   │                 → DNS pre-check (getent hosts)
   ├─> cp index.html + setup-solo-mining.html + logo → /var/www/grin-solo-mining-stat
   ├─> write data/config.json: stratum ports + advertised IP + slogan + portcheck_api
   │     (collector reads it; editable live — no redeploy for slogan/ports)
   ├─> _solo_prompt_payout_split → write/remove /opt/grin/conf/grin_solo_payment.json
   ├─> install collector (see COLLECTOR below) → cron every 5 min + initial run
   ├─> _solo_prompt_access_lock (public mode) → apr1 htpasswd (see ACCESS LOCK)
   ├─> write vhost:
   │     · per detected net: location = /api/status/<net> → node Owner API get_status
   │       (Basic Auth injected; rate-limit zone solo_stats_api) + wallet liveness probe
   │     · location / → static web_dir ; chmod 600 (b64 token in conf)
   │     · LAN: listen <ip>:<port>   ·   public: listen 80 (certbot adds 443)
   ├─> nginx_enable_site (include + symlink + nginx -t + reload)
   └─> public mode: nginx_run_certbot(subdomain, --redirect) → 443 + HTTP→HTTPS
         on failure: page stays live over HTTP, prompt to fix DNS & retry

   Reused shared-lib helpers (lib/nginx_shared_helpers.sh): nginx_install_with_certbot ·
   nginx_validate_domain · nginx_enable_site · nginx_run_certbot · nginx_test_reload.

 ─── COLLECTOR   lib/07_mining_block_collector.py ──────────────────────────────
   Installed → /usr/local/bin/grin-solo-mining-collector.py (+ wrapper), cron */5,
   state /opt/grin/solo-stats/. Parses the node log → per-net SQLite
   (solo_mining_stats_<net>.db) + derived JSON the page reads:
     blocks_<key>.json · miners_<key>.json · poolstats_<key>.json (miningpoolstats
     pollable) · split_main.json (payout split, mainnet only, when enabled).
   Also maintains the payout ledger (matured-block earnings, chain-verified at
   maturity) and answers the settlement CLI (--list-balances / --record-payment /
   --list-payments) used by menu 7.

 ─── PAYOUT SPLIT (mainnet, display + running balance)  grin_solo_payment.json ─
   Opt-in toggle (one prompt in deploy). For a TRUSTED friend group sharing the
   solo pool: solo always pays ONE coinbase wallet; the split just shows who earned
   what so the operator settles by hand. NO Grin addresses stored, ever.
   · Identity = nickname = worker text BEFORE the first dot (alpha.01, alpha.02 →
     alpha). Automatic grouping; nothing to pre-register.
   · Fairness = matured-block reward (60 GRIN, no halving) split by work-share
     (difficulty-weighted, not raw share count). Only MATURED (chain-verified,
     1440-block) blocks count → an orphan never inflates a split.
   · Running balance per nickname: All-time earn − Paid = To be Paid (see menu 7).

 ─── ACCESS LOCK (public mode)  STATS_HTPASSWD /etc/nginx/grin-solo-stats.htpasswd ─
   Opt-in HTTP Basic Auth over the certbot HTTPS (openssl passwd -apr1 → no
   apache2-utils). Default: PROTECT location / + /api/* + split_main.json; leave
   poolstats_*.json PUBLIC so miningpoolstats.com can still poll. Optional
   sub-choice hides poolstats too. HTTPS-only (the :80 block 301s first).

================================================================================
 4) NODE, WALLET & MINING STATUS   show_node_status()   (top menu ▸ 4, both nets)
================================================================================
   _show_node_info(net) per network:
     ├─> Node   : ss :api → RUNNING (PID, binary, dir, tmux attach hint via
     │            gnc_has_grin_session → gtmux|tmux) / NOT RUNNING
     ├─> Wallet : ss :3420/13420 → LISTENING (combined Owner+Foreign) / NOT RUNNING
     │            / not configured
     ├─> Stratum: ss :stratum → LISTENING + ESTAB miner count / not listening
     └─> toml   : enable / bind / wallet_listener_url / burn

================================================================================
 5) WATCHDOGS (global)   watchdog_menu()   (top menu ▸ 5)
================================================================================
 Four independent keepalives; header shows the state of each.
   1/2) Node-sync watchdog ....... gnk_watchdog_install / _remove   (grin_node_keepalive.sh)
          restarts a WEDGED node (height not advancing vs external reference),
          not just a dead PID. External ref = 2+ THIRD-PARTY nodes (NEVER the
          operator's own api.grin.money — circular). Fetch failure ≠ restart.
          Anti-flap: state file + cooldown + post-restart grace.
   3/4) Node boot-autostart ...... gnk_autostart_enable / _disable  (per net / both)
          ONE shared tag-guarded @reboot cron (also managed by Script 03).
   5/6) Wallet-listener watchdog . sw_watchdog_install / _remove   (*/5, relaunch 3420/13420)
   7/8) Stratum watchdog ......... solo_stratum_watchdog_install / _remove
          (*/5, /etc/cron.d/grin-stratum-watchdog — WARN if stratum drops / drifts)
   0) Back
   NOTE: candidate to fold 1+5+7 into ONE "solo health" */5 cron eventually.

================================================================================
 6) MAINTENANCE   maintenance_menu()   (top menu ▸ 6, lib/07_solo_backup.sh)
================================================================================
 Encrypted backup of everything a solo miner can't recreate.
   1) Deploy new code ...... solo_deploy_code()   re-copy collector .py + web page
                              from the checkout (git pull via Admin 08→8 first)
   2) Backup now ........... sb_backup_now()   AES-256-CBC PBKDF2-600k, pass on fd:3
        archives /opt/grin/solowallet (wallets+binary+seed+.passphrase),
        /opt/grin/solo-stats (SQLite, online-backup snapshot), grin_solo_payment.json
        → /opt/grin/backups/grin_solo_backup_<DDMMYYYY>.tar.gz.enc (600)
   3) Restore from backup .. sb_restore()   pick file → type personal key → extract
                              to original paths (tar -C / -p)
   4) Schedule daily ....... sb_schedule()   cron + <keep>-archive retention
   5) Settings ............. sb_settings()   personal key · retention · list
   6) Show recovery seed ... sb_show_seed(net)   the ultimate wallet backup
   0) Back
   Password model: <personal_key><DDMMYYYY>. personal_key stored b64 in
   grin_solo_backup.conf (600) for the unattended cron; typed by hand on restore.
   NOT backed up: node dir / grin-server.toml (re-publish stratum after restore),
   nor the backup key itself.

================================================================================
 7) PAYOUTS & SETTLEMENT   solo_settlement_menu()   (top menu ▸ 7, MAINNET)
================================================================================
 Requires the mainnet stats DB (deploy stats page ▸ 3 with payout split enabled).
   Shows a per-nickname running balance:
     All-time earn (matured-block rewards) − Paid (recorded) = To be Paid.
   1) Record a payment ..... _settlement_record_payment()
        numbered picker (biggest To-be-Paid first) → nickname → amount
        (Enter = full owed) → note → confirm → collector --record-payment
        → refresh split_main.json now (don't wait for cron)
   2) Payment history ...... _settlement_show_history()   latest 20, newest first
   0) Back
   Pay each nickname OUT-OF-BAND (one normal Grin tx from your own address book),
   then record it here so 'To be Paid' drops. No address is ever stored or shown.

================================================================================
 C) CLEAN UP   solo_cleanup()   (top menu ▸ C, DANGER ZONE)
================================================================================
 Removes solo infra (stratum config revert, collector bin/wrapper/cron + state,
 stratum watchdog, stats vhost/web dir) with per-group confirmation. KEEPS the
 node + grin-server.toml, the wallet seed (/opt/grin/solowallet), and encrypted
 backups (/opt/grin/backups) + key. Full destructive wipe lives in Script 08del.

================================================================================
 INTERNAL HELPERS
================================================================================
  find_grin_server_toml(net, api_port)   ss PID → readlink /proc/pid/exe → toml;
        else scan known dirs by chain_type; prompt if multiple/none → FOUND_GRIN_TOML
  _resolve_stratum_toml(net, api_port)    non-interactive variant (status screens)
  graceful_restart_grin(api_port, net)    ss PID → binary/dir → tmux session →
        kill -TERM (wait 30s, -KILL) → SHELL=/bin/bash tmux new-session restart
  _find_grin_session_for_pid(pid)         map node PID → tmux session name
  _detect_public_ipv4 / _detect_lan_ipv4  advertised stratum host (Internet / LAN)
  _stratum_bind_line(toml, port)          PUBLIC/LOCAL/not-set for the status header
  sw_* (lib/07_solo_wallet.sh)            combined listener / cron / watchdog / address
  gnc_* (lib/grin_node_control.sh)        gnc_owner_get_status · gnc_has_grin_session
  gnk_* (lib/grin_node_keepalive.sh)      node boot-autostart + node-sync watchdog

  Sourced libs: nginx_shared_helpers · grin_node_secrets · grin_node_control ·
  grin_node_keepalive · 07_solo_wallet · 07_solo_backup · grin_wallet_install.

================================================================================
 PORT REFERENCE
================================================================================
  Stratum (miners → node)            Mainnet 3416   Testnet 13416
    grin-server.toml → stratum_server_addr
  Node Owner API (local — stats/watchdog/precheck)   Mainnet 3413   Testnet 13413
  Wallet combined listener — Owner API + mounted Foreign (coinbase delivery)
    Mainnet 3420   Testnet 13420
    grin-server.toml wallet_listener_url → http://127.0.0.1:3420  (node adds /v2/foreign)
    (was bare-`listen` Foreign 3415/13415 before the 2026-07-06 combined
     `-p owner_api` + owner_api_include_foreign change)

================================================================================
 SECURITY MODEL
================================================================================
  · Node .api_secret (/opt/grin/node/<net>-prune/) never leaves the VPS; nginx
    injects Basic Auth for /api/status → browser never sees it; conf chmod 600.
  · Wallet .passphrase (/opt/grin/solowallet/<net>/) chmod 600 — enables unattended
    `-p owner_api` boot; trade-off = passphrase in the listener argv (ps aux).
  · Stratum opened to 0.0.0.0 only when the operator runs Setup & Publish (firewall
    rule added then); Restrict reverts to 127.0.0.1.
  · Access lock (optional, public mode): apr1 htpasswd 640, HTTPS-only; keeps
    poolstats_*.json public for miningpoolstats unless the operator opts to hide it.
  · Payout split stores NO Grin addresses — nicknames + % + GRIN only.
  · Node-sync watchdog never trusts a bare PID and never uses the operator's own
    endpoint as the external truth (circular); external fetch failure ≠ restart.

================================================================================
 LEDGER / TIME conventions
================================================================================
  · Collector ledger day-keys + timestamps in UTC; the web page converts UTC →
    the viewer's local timezone for display.
  · Matured-block counting is chain-verified at 1440 maturity (get_block hash
    compare) so an orphan never inflates a payout.
  · Testing: local `bash -n` + /check + /review only (needs a Linux + root VPS to
    run); the operator runs live on the VPS.

================================================================================

```

================================================================================
 ABANDONED-BALANCE DISPOSITION + MANUAL PAYOUT  (add-ons, 2026-07-22)
================================================================================
Problem: the pool is custodial between credit and payout. A miner can accrue a
balance then vanish (lost seed/pass, abandoned rig). Left forever, these balances
bloat the ledger and sit as an unbacked-looking liability. Operator question:
what to do with them, correctly and defensibly?

DECISION (locked with operator, 2026-07-22):
  · An address with NO accepted share AND NO successful payout for `dormancy_months`
    (default 24), still holding a balance, is "abandoned".
  · Its balance is SWEPT and REDISTRIBUTED to miners active in the last
    `dormancy_active_window_days` (default 30), weighted by recent sustained work
    (hashrate_history — raw shares prune within ~a day, so they can't back a 30-day
    window; hashrate_history is kept 100d and is the same source the lottery uses).
  · Disposition is FINAL. The owner reclaims any time BEFORE it (account-page
    countdown + public masked list) by simply requesting a payout. NOT after.
  · Funds go to ACTIVE MINERS, NEVER the operator. This is the ethical anchor and
    the line the ToS/banner must state.
  · Why final-and-redistribute (not reserve, not reclaim-forever): the "redistribute
    + reclaim-forever" combo is exploitable — a whale can let one address go dormant,
    farm most of the redistribution back to its active addresses, then reclaim the
    original from pool funds. Making disposition FINAL kills the exploit (the faker
    just loses money waiting) while still rewarding the miners who secure the pool.
    OFF by default — enabling it is a deliberate, disclosed operator decision.

┌── REVISION 2026-07-22b (operator): DESTINATION CHANGED → COMMUNITY PRIZE POOL ──────┐
│ After discussion, the swept balance is NO LONGER split among active miners. It is    │
│ swept into the single `prize_pool` bucket instead — where it is given away through   │
│ the pool's existing, publicly-auditable draws (Pot A whale-cap + Pot B equal-chance).│
│ WHY the change (simpler + more transparent + fairer):                                │
│   · Deletes the entire recipient-selection engine — no equal-vs-weighted decision,   │
│     no Sybil-per-address hole (equal split would be farmable), no dust-spraying a     │
│     tiny balance across hundreds of miners (0.005 GRIN each = pointless + N log rows),│
│     no "no active recipients → defer" edge case. Prize pool always exists.            │
│   · Small dormant balances (the typical case — sub-threshold dust that could never    │
│     auto-pay) accumulate and are handed out in meaningful chunks, not sprayed.        │
│   · Small miners still get the "fair" outcome via Pot B equal-chance, but behind the  │
│     lottery's anti-Sybil gates (min-active-days + min-work) — not a raw money split.  │
│   · Still an INTERNAL transfer, still NEVER the operator. Because prize_pool is        │
│     excluded from custodial liability, sweeping there correctly REDUCES miner-owed.   │
│ LEDGER: per-source debit reference_type='dormant_sweep' UNCHANGED; the credit is now  │
│   a SINGLE row to prize_pool, reference_type='dormant' (was per-recipient             │
│   'dormant_payout'). Σdebit == the one credit → integrity invariant still nets 0      │
│   (INV_CASES sums credit/debit regardless of ref_type). remainder always 0,           │
│   recipient_count always 1. No reconciliation break; added prize.from_dormant to the  │
│   bucket breakdown for transparency.                                                  │
│ TRANSPARENCY (the point of the change): incentives.prizePoolStatement() = lifetime    │
│   in/out by source over the rollup horizon; public GET /api/pool/prize-pool +          │
│   donate.html D-05 panel; admin GET /api/admin/incentives/prize-pool statement +      │
│   settings-incentives.html breakdown. The earlier "whale exploit" rationale below is   │
│   now moot — a whale can't farm a lottery pot back the way it could a direct split.   │
└──────────────────────────────────────────────────────────────────────────────────────┘

GRANDFATHERING: the clock counts from max(last_activity, dormancy_policy_effective_at).
The first enabled run stamps `dormancy_policy_effective_at = now` and disposes NOBODY,
so every address gets a full window of runway after the policy goes live. Operators can
only ever push the anchor later (more runway), never retroactively shorten it.

LEDGER MODEL (why it's safe on the custodial books):
  · Disposition is an INTERNAL transfer: Σ debited from sources == Σ credited to
    recipients (rounding remainder handed to the top-weight recipient), so the
    reconciliation integrity invariant nets to exactly zero and the coins never leave
    the wallet. Fresh reference_types keep it OUT of the external IN/OUT flow:
      - debit  source     → reference_type='dormant_sweep'
      - credit recipient  → reference_type='dormant_payout'  (reference_id = batch id)
    reconciliation.js INV_CASES sums by event_type (credit +, debit −), so no change
    to reconciliation.js is needed; ledger-rollup keeps (addr,event_type,ref_type) as
    dimensions so the new types roll up automatically.
  · Guards: excludes reserved pseudo-addresses (pool_fee/prize_pool) and banned
    addresses; freeze-aware (skips while payouts frozen); DEFERS if there are no active
    recipients (never sweeps into the void — balances stay put, reclaimable).

SUB-THRESHOLD PAYOUT (below-min "email support to withdraw" flow):
  A below-min miner who wants to stop and withdraw emails support. Admin first verifies
  ownership — types the CLAIMED mining IP or rig password into
  /api/admin/dormancy/verify-owner → verifyOwnerProof() returns match/no-match ONLY
  (proofs are salted-scrypt hashes; nothing is revealed). Then TWO paths (the
  "Tor + hardened recorder" scope chosen 2026-07-22):

  PRIMARY — backend-initiated Tor send (/api/admin/dormancy/send-payout, freshAdmin):
    the pool sends it itself, through the SAME locked withdrawal flow a miner uses, via
    withdrawalScheduler.createWithdrawal(addr, amt, 'tor', {adminOverride:true}). The new
    `adminOverride` opt bypasses ONLY the min-withdrawal floor + the post-failure reversal
    cooldown; the freeze, the CAS balance lock, and the one-pending-per-address cap (the
    double-pay guard — a second send while one is pending is rejected 429) ALL still apply.
    Real network fee + kernel are captured by the scheduler and recorded automatically —
    no out-of-band step, no send-then-record window. Requires the miner's wallet listener
    reachable over Tor (scheduler declines + reverses the lock if not).
    withdrawal_events.triggered_by = 'admin_override'.

  FALLBACK — recorder (/api/admin/dormancy/manual-payout, freshAdmin): for a send the
    admin already made out-of-band (slatepack / wallet CLI). manualPayout() writes a
    CONFIRMED withdrawals row (method='manual') + a 'withdrawal' debit — SAME taxonomy as
    an automated payout, which keeps coverage correct AND makes
    reconciliation.auditWalletSends() MATCH the send instead of flagging false theft.
    Never raw-subtract a balance (breaks the integrity invariant). HARDENED against
    double-submit (review finding #1): dedup rejects a duplicate kernel_excess/slate_id
    (a unique on-chain id) or an identical (address, amount, method='manual') within 60s
    → {ok:false, duplicate_*}; the frontend also disables the button in-flight. Without
    this a resubmit would write a 2nd debit for one real send → over-debit + audit drift.

  SLATEPACK from the admin panel is deliberately NOT built as a broker UI — an interactive
  Mimblewimble tx is an unavoidable 2-message round-trip (there is no non-interactive
  slatepack send in Grin), so slatepack cases route through the recorder rather than
  pretending the panel makes them convenient.

CODE MAP:
  · lib/dormancy.js — DormancyManager: _candidates, listDormant (masked/unmasked),
    statusFor (account countdown), history, preview (dry-run), runOnce (the atomic sweep
    → single prize_pool credit; 6h scheduler + first pass 60s after boot), manualPayout.
    maskAddress = grin1qxy…mn4p. (_activeRecipients removed in the 2026-07-22b revision.)
  · lib/incentives.js — prizePoolStatement(recentLimit): lifetime in/out breakdown by
    source (fee_cut/donation/topup/dormant in; prize_award/jackpot/join_bonus/streak out)
    over the ledger-rollup horizon + balance + recent rows. Shared by admin + public.
  · db.js — dormancy_dispositions (one row/batch) + dormancy_disposed_sources (one
    row/swept address); never pruned → historical detail behind the public page after
    raw balance_log prunes at 60d.
  · pool-settings.js — payout.{dormancy_enabled(false), dormancy_months(24),
    dormancy_active_window_days(30), dormancy_policy_effective_at(0=auto)} + validators;
    ToS `terms` default gained "4. Abandoned and unclaimed balances" (existing pools
    must add the clause manually — pages are seeded once into the CMS `pages` table).
  · lib/withdrawal-scheduler.js — createWithdrawal() gained a 4th arg `opts`; opts.adminOverride
    bypasses only the min floor + reversal cooldown (all other guards intact) and stamps
    withdrawal_events.triggered_by='admin_override'.
  · index.js — GET /api/pool/unclaimed (public, masked: dormant list + disposition
    ledger); account `/api/account/:addr` gains a `dormancy` field; admin GET
    /api/admin/dormancy (status+preview+unmasked list+history, secureAdmin), POST
    /run + /manual-payout + /send-payout (freshAdmin) + /verify-owner (secureAdmin).
    /send-payout honours the freeze and maps createWithdrawal's numeric .code to HTTP status.
  · Frontend — payment-history.html: page-scoped notice banner (payout part only, NOT
    site-wide) + U-01 tiles / U-02 masked dormant list (+ "check your own account page"
    disambiguation) / U-03 redistribution ledger. account-settings.html: per-address
    dormancy notice (counting/eligible/disposed) + a sub-threshold "email support" note
    (#acct-subthreshold, shown only when 0<balance<min; reuses branding.js contact-link).
    admin payments.html: dormancy KPIs + "run now" + "Pay a below-minimum miner" (ownership
    verify → ⚡Send Tor payout now [primary] OR Record out-of-band send [fallback, button
    disabled in-flight]) + dormant list + history. settings-payout.html: config controls.
    [2026-10 payouts split: the KPIs, "run now", dormant list and history now live on
    admin dormant.html (Payouts → Dormant balances); "Pay a below-minimum miner" is the
    collapsed "Manual payout — support request" card on payments.html (Payouts → Queue),
    still calling /api/admin/dormancy/*. Implementation §10.14.]

STATUS: BUILT on `add-ons` 2026-07-22, node --check + integration smoke tests (temp DB:
disposition weights/remainder, reserved+banned exclusion, grandfather, over-balance reject;
below-min adminOverride locks funds + one-pending cap blocks a 2nd send; recorder dedup
rejects duplicate kernel/slate/recent, no double-debit — all verified). NOT YET VPS-tested.

---

## Node binary change marker (Solo Health)

**Status:** built 2026-10-28 (collector `07_mining_block_collector.py` and `web/07_mining_pool_solo/index.html`), uncommitted, not VPS-tested. Where the build differs from the text below, the code wins: see the hint sentence and the window rule.

Line references are to the `add-ons` branch at `cdbf2d2`.

### Why it exists

On 2026-10-28 the stale cell in "Solo Health · Mainnet" turned yellow after the operator swapped
the node binary. The card showed the symptom, but nothing on it said the binary had changed.

The marker puts that fact next to the stale rate. The cause is still measured in Diagnostics &
Support Bundle (hub 08, key 6) → key 8, Mining / stratum latency
([`script086_design.md`](script086_design.md) §10).

Solo gets only the marker and one hint sentence. It does not try to diagnose anything.

### Where the collector reads it

There is one new function, `track_node_binary(conn, net, status, now)`, in
`scripts/lib/07_mining_block_collector.py`. `main()` calls it right after
`status = query_node_status(args.net)` (`:1706`), on both nets. It runs inside its own
`try`, so a failure prints one stderr line and never stops the collector run. (cron discards
that line, `07_solo_stats_page.sh:647`; `--dry-run` shows it.)

- **`--dry-run`** computes the version and the sha and prints them with what it would record
  ("tracking starts", "unchanged", "change from <sha> to <sha>"). It writes nothing: the
  dry-run branch returns before `db_connect` (`:1636-1679`), and the marker keeps it that way.
- **Count-once stays intact.** The function runs after `scan_increment` and before
  `save_state_db`. It writes only its own table and its own `meta` key, never `log_pos` or a table
  `save_state_db` rewrites. A crash between the two commits re-reads the same log span on the
  next run, as it already does, and finds the same sha, so no duplicate row is written.

- **Version.** Taken from `status["user_agent"]`, the running node's `get_status`
  (`query_node_status`, `:561-581`; grin `api/src/types.rs:76`).
  - grin builds the string as `MW/Grin <version>[.<git short hash>]` (`p2p/src/msg.rs:49-55`,
    v5.5.2), so a source build already names its commit. Whether an official release binary
    carries a hash too is UNVERIFIED.
  - The `MW/Grin ` prefix is stripped. What remains must match `[0-9A-Za-z.+-]{1,40}`, or the
    version is stored as null.
  - If the node is down (`status` is None), the version is null for that run.
- **sha256.** The hash of `<node_dir(net)>/grin` (`node_dir`, `:527-540`).
  - The collector runs as root from cron (`scripts/lib/07_solo_stats_page.sh:646-649`), so the
    file is readable.
  - The file is hashed again only when its `(st_ino, st_size, st_mtime_ns)` differs from the
    cached stat. The binary is tens of MB, so it is not hashed every 5 minutes.
  - **This is the file on disk, not the running image.** Script 01's key G stops the node, swaps
    the file and starts it again (`01_lib_source_build.sh:893-937`), so the two agree within a run.
    The version above always comes from the running node, which covers the gap (see change
    detection).

### Storage

The marker uses the collector's SQLite state database, `solo_mining_stats_<key>.db`
(`:1593`).

- **A new table** goes into `DB_SCHEMA` (`:307-321`). `db_connect` runs the schema on every
  connect (`:338`), so the table is created on the next run with no migration:

  ```sql
  CREATE TABLE IF NOT EXISTS node_binary_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,          -- detection time, epoch seconds
    sha256 TEXT NOT NULL,      -- full hex; only 12 chars are ever published
    version TEXT,              -- user_agent without "MW/Grin ", or NULL
    first INTEGER NOT NULL DEFAULT 0   -- 1 = first row ever: tracking started, not a change
  );
  ```

- **The stat cache** is a `meta` row, `node_binary_stat` = `{"ino","size","mtime_ns","sha256"}`,
  written with `_meta_set` (`:353-354`).
- **The table is append-only.** It is deliberately not part of `save_state_db` (`:389-426`),
  which deletes and rewrites every table it owns on each run. `track_node_binary` writes in its
  own `with conn:` transaction.
- **Backup.** The table lives in the same `.db`, so the existing tar backup of
  `/opt/grin/solo-stats/` (`:300-306`) carries it.
- **Retention.** The `first = 1` row and the newest 20 change rows are kept. Older change rows
  are deleted in the same transaction. The `first = 1` row is never deleted, because
  `tracked_since` comes from it.

### Change detection

- **Changes are keyed on the sha.** A new row is written when the sha differs from the newest
  row's sha. The version alone cannot detect a change: a staging build may keep its version
  string, and a build without a git checkout adds no commit hash.
- **`ts` is when the collector noticed,** up to 5 minutes (one cron period) after the swap. The
  page says "changed", and the ⓘ text does not promise minute precision.
- **The first run ever** writes one row with `first = 1`. Installing or upgrading the collector
  is not a binary change, and the page never calls it one.
- **Swap now, restart later.** While the sha equals the newest row's sha, a different non-null
  version only **updates** that row's `version`. So a swap followed by a restart a few minutes
  later is one change, not two.
- **An unreadable file or a missing hash** writes nothing and keeps the last state. A missing
  binary does not count as a change.

### JSON field

The marker is published only in `split_main.json` (mainnet). The Solo Health card reads only
that file, and the card is hidden without it (`index.html:617`). The field sits inside the
`quality` block, next to `windows`. `main()` adds it to the dict `build_quality` returns
(`:1268-1274`) before `save_json_atomic` (`:1742-1753`):

```json
"quality": {
  "windows": { "...": "unchanged" },
  "node_binary": {
    "version": "5.5.2.ab12cd3",
    "sha": "9f3c1e0a7b2d",
    "since": "2026-10-27T18:04:11+00:00",
    "tracked_since": "2026-09-01T00:05:02+00:00",
    "previous": {"version": "5.5.2", "sha": "41d07c9e55aa"},
    "in_windows": ["daily", "weekly", "monthly"]
  }
}
```

- `since` is the newest `first = 0` row, or `null` when nothing has changed since tracking
  began. `previous` is `null` in that case too.
- `in_windows` names the windows whose span contains `since`, computed by the collector with the
  same `now` as `build_quality` (`:1263-1274`) and the same day granularity: daily is today (UTC),
  weekly is `utc_day(since) >= utc_day(now - 7 d)` and monthly is `utc_day(since) >= utc_day(now - 30 d)`.
  `build_quality` counts shares by UTC day, so a change on the first day of a window is inside it even
  when it is older than exactly N × 24 h. The page reads the list and never redoes the window maths,
  so the two cannot drift. It is `[]` when `since` is null.
- The older change rows stay in the database only. No page reads them, so they are not
  published.
- Times use `iso_utc()` (`:240-247`), which carries `+00:00`. They never use `iso()`
  (`:236-237`), which is naive local time and which the browser would read in the visitor's
  zone.
- `node_binary` is omitted entirely when the table is empty. Old pages then ignore it, and a
  new page shows no line.
- Testnet rows are kept in the testnet database but never published, since there is no testnet
  split file.

### How `renderQuality()` shows it

`renderQuality()` is in `web/07_mining_pool_solo/index.html:1595-1640`.

- **New element.** A `<p class="split-meta" id="quality-binary">` sits directly under
  `#quality-meta` (`:622`). It is hidden when `d.quality.node_binary` is absent.
- **Text,** set with `textContent`, never `innerHTML`, because the version string comes from the
  node:
  - with a change: `Node binary 5.5.2.ab12cd3 · 9f3c1e0a7b2d — changed 2026-10-27 18:04 UTC
    (was 5.5.2 · 41d07c9e55aa)`;
  - without one: `Node binary 5.5.2 · 41d07c9e55aa — unchanged since tracking began
    2026-09-01 UTC`.
- **Always UTC.** Times are formatted with `dparts('utc')` (`:1108-1120`), whatever the page's
  🕓 toggle says. The card is already labelled "UTC days" (`:620`), so the marker uses
  the same zone and says "UTC" once in its line.
- **Window flag.** Each Daily, Weekly or Monthly row named in `in_windows` gets a `⚑` after its
  label. Its `title` reads "Node binary changed inside this window (2026-10-27 18:04 UTC)". A
  stale rate that rose in exactly the windows carrying the flag is the pattern to look for.
- **Narrow screens.** The line is an ordinary wrapping `<p>`, with no `nowrap`, so at 360 px it
  wraps instead of scrolling sideways. It sits outside `.table-scroll`, so the table's layout
  does not change.
- Nothing else on the card changes. `metricCell`'s 3 % / 8 % thresholds (`:805-810, 1615`) stay
  as they are.

### Hint sentence (the card's ⓘ text)

One sentence is appended to the first `split-foot` paragraph under "ⓘ About this card"
(`index.html:643-646`):

> If stale&nbsp;% rose in the windows marked ⚑ (the node binary changed there), measure how long
> the node takes to hand out a new job: in the toolkit menu, Admin &amp; Maintenance → Diagnostics &amp;
> Support → Mining / stratum latency (keys 8 → 6 → 8).

As built, the sentence names the menu path the operator types (keys 8 → 6 → 8), not the hub number.

### What is public, and what never is

- **Published:** the version string (sanitised, at most 40 characters) and the first 12 hex
  characters of the sha.
- **Never published:**
  - the binary's path or node dir;
  - the hostname;
  - the source ref, commit message or artifact name;
  - toolkit patch names;
  - the full sha.
  - Those stay in the database (the full sha) or are never read (the rest).
- `health.json` is unchanged. It stays booleans and counts only (`:790-809`).
- A short sha fingerprints a custom build. That is the purpose, and it says nothing about the
  host.

### Open items

- **The running image.** Hashing `/proc/<pid>/exe` instead of the file would catch a swap with
  no restart. But the collector has no pid discovery, and it would need the exe-only match
  (`gnc_grin_pids_for_dir`, `scripts/lib/grin_node_control.sh:222-235`) ported to python.
  Deferred.
- **`node_dir()` prefers the `-full` dir over the running node when both dirs exist.** To be fixed as a
  separate task by porting the tmux preference of `grin_live_node_dir` (`scripts/lib/grin_node_secrets.sh:65`)
  into the collector. Not part of the marker's build.
- **Which dir is hashed.** `node_dir()` picks by conf vars and the presence of a toml
  (`:527-540`), not by the running process. On a box that still holds both a `-full` and a
  `-prune` dir after a rebuild, it can name the dir that is not running. The version (from the
  running node) then changes while the sha does not, and no change row is written. The same
  choice already decides which log and secret the collector reads.
- **Pages without the payout split.** With the split disabled there is no `split_main.json`,
  so neither the card nor the marker exists. This is inherited from the card.
