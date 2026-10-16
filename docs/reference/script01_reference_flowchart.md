╔══════════════════════════════════════════════════════════════════════════╗
║               01_build_new_grin_node.sh  —  ENTRY + MENU                 ║
╚══════════════════════════════════════════════════════════════════════════╝

> **Covers code as of:** 2026-10-15 for the ENTRY + MENU section, the Super Auto box and the key-flow notes at the end; 2026-07-01 for Steps 1b–14 in between, which the menu work did not change but nobody has re-read against the code since · **Last verified:** never systematically verified
> **Product code last changed:** 2026-10-15 — `scripts/01_build_new_grin_node.sh` split into an entry plus `scripts/lib/01_lib_*.sh`; new menu (`lib/01_lib_menu.sh`) and node table (`lib/01_lib_node_table.sh`), plus the custom wizard's Step 14c autostart offer (`lib/01_lib_super_auto.sh`), working tree at the time of writing; 2026-09-25 — `scripts/lib/01_lib_source_build.sh` + new `scripts/patches/grin/` (key G offers toolkit grin patches after checkout; not described here); 2026-08-18 — `scripts/lib/01_lib_source_build.sh`

As-built detail, keys per state and the Build notes → [script01_implementation.md](script01_implementation.md).

        main():  root check → flock /var/run/grin-toolkit-01.lock → s01_menu_loop
                                    │
          ┌─────────────────────────▼──────────────────────────────────────┐
          │  EVERY PASS of s01_menu_loop  (lib/01_lib_menu.sh)              │
          │─────────────────────────────────────────────────────────────────│
          │  s01_reset_state    wizard globals back to start; GRIN_BIN_TMP  │
          │                     re-seeded from GRIN_PREBUILT_BIN (a key-G   │
          │                     build survives)                             │
          │  s01_scan_nodes     ONE read-only scan, per network:            │
          │                     conf + disk + grin PROCESS (binary = dir/   │
          │                     grin, not "port bound") + tmux session      │
          │                     (gtmux or root) + non-grin holder of the    │
          │                     P2P port 3414 / 13414 (never 3415: wallet)  │
          │  s01_render_status  one line per network, conf-vs-disk verdict, │
          │                     red line for a foreign port holder          │
          │  s01_render_keys    a key that cannot act = DIM + its reason    │
          └─────────────────────────┬──────────────────────────────────────┘
                                    │
              Select [1-5 / G A / 0]    typo or dim key → re-prompt
                                    │    (never exits; only 0 / EOF leaves)
     ┌───────┬──────────┬───────────┼────────────┬───────────┬──────┬───────┐
     1       2          3           4            5           G      A       0
   Start    Stop     Update       Rebuild      Install    source   Super   leave
   a node   a node   binary       a node       a node     build    Auto
     │       │          │            │            │         │        │
     │       │          │            │            │         │        │
     ▼       ▼          ▼            ▼            ▼         ▼        ▼
  pick net  pick net  pick net    pick net    legacy-dir   gsb_menu run_super_auto
  (only the (only the (mainnet/   (nets with   check        (lib/    ★ (see box
  nets that nets that  testnet/    a node dir) → OS/deps    01_lib_   below)
  can start) run)      both,         │         → select_     source_
     │       │         Enter=both)   │           network     build)
     ▼       ▼          │       ┌────┴────┐      (FREE nets
 s01_start s01_stop     ▼       1         2       only)
 _node     _node    update_   chain_data  full      │
  │         │       binary_   only        reinstall ▼
  │         │       only      (typed      (typed   setup_one_node
  │         │         │       REBUILD)    REBUILD, (Steps 4–14 below)
  │         │         │          │        or DELETE-
  │         │         │          ▼        ARCHIVE
  │         │         │    rebuild_chain_ for a full
  │         │         │    data_only      archive)
  │         │         │    stop THAT         │
  │         │         │    node → refuse     ▼
  │         │         │    while a grin   s01_full_reinstall
  │         │         │    proc of the    stop THAT node → delete its
  │         │         │    dir lives →    dirs + conf lines →
  │         │         │    rm chain_data  setup_one_node <that net>
  │         │         │    only → fetch   (pruned/full asked at Step 4;
  │         │         │    + extract →    secrets + .onion survive)
  │         │         │    start
  │         │         ▼
  │         │   download release ONCE → per node (mainnet first):
  │         │   stop → swap binary (grin.prev + /opt/grin/bin copy)
  │         │   → start ONLY IF it was running → GRIN_STAGGER_SECS
  │         │   gap before the second node is stopped
  │         ▼
  │   planned-stop marker → SIGTERM that dir's grin → kill ITS session
  │   (exact -t "=name", both tmux servers) → sweep that dir's leftovers
  ▼
  gnc_launch_node_session (grin user, HOME=dir, gtmux); orphan cleared first;
  failure is returned, not die'd

   Every action ends with "Press Enter" → back to the top of the loop (fresh scan).
   Hidden aliases: s→1   b→3   m→4 mainnet   t→4 testnet.
   Gone: K, C, N, R and the wizard's pruned↔full switch (now 4 → full reinstall).

   ★ A (Super Auto) wipes BOTH nodes. It returns to the menu when it finishes
     or is cancelled. See the "SUPER AUTO — one-hit" box below.

   Keys 5, 4 → full reinstall, and A continue into the setup pipeline below
   (Step 1b → Step 2 → … → Step 14), once per node.
                                    │
                    ┌───────────────▼────────────────────────┐
                    │   STEP 1b — Legacy directory check     │
                    │   detects $HOME/.grin                  │
                    │   D → delete (recommended)             │
                    │   Enter → keep (may cause conflicts)   │
                    │   0 → return to master script          │
                    └───────────────────────────────────────-┘
                                    │
         ┌──────────────────────────▼────────────────────────────────────────┐
         │   SUPER AUTO — one-hit: wipe & rebuild BOTH nodes (run_super_auto) │
         │   (chosen via A on the menu; sets SUPER_AUTO=true)                 │
         │───────────────────────────────────────────────────────────────────│
         │  Opinionated, near-zero-interaction path. Hard-wired choices:      │
         │    • BOTH networks, PRUNED only   • on-the-fly STREAMED chain data │
         │    • zone = "all" (auto-pick fastest fresh source across zones)    │
         │                                                                    │
         │  1. Soft disk gate — free GiB on fs holding /opt/grin/node.        │
         │        _super_auto_free_gb  (walks up to first existing parent).   │
         │        < 20 GiB → warn; type FORCE to override, else cancel (→1).  │
         │        This gate IS the disk check → sets GRIN_SKIP_DISK_CHECK=1.  │
         │                                                                    │
         │  2. State-aware confirmation (detect running ports + installed):   │
         │        running(3414/13414) OR installed → DESTRUCTIVE list;        │
         │            type REBUILD to proceed, else cancel (→1)               │
         │        clean box → simple [Y/n]                                    │
         │                                                                    │
         │  3. Wipe (stop = s01_stop_all, no pattern sweep):                  │
         │        stop_grin_gracefully → _remove_instance_dirs all            │
         │        → truncate INSTANCES_CONF                                   │
         │                                                                    │
         │  4. check_os_and_deps → check_legacy_grin_dir                      │
         │        SUPER_AUTO=true ; GRIN_SKIP_DISK_CHECK=1                    │
         │        setup_one_node "mainnet"  → setup_one_node "testnet"        │
         │        (each: Steps 4–14 with prompts SUPPRESSED — see below)      │
         │                                                                    │
         │  SUPER_AUTO suppresses per-step prompts:                           │
         │    Step 4  select_archive_mode  → forced "pruned", no prompt       │
         │    Step 9  download_chain_data  → forced stream (choice 1)         │
         │    Step 9  zone select          → forced "all"                     │
         │    Step 14 show_summary         → "auto-start/watchdog/logrotate   │
         │                                    being configured" (no reminder) │
         │                                                                    │
         │  Per-node POST-BUILD HARDENING  (_super_auto_harden, after         │
         │  save_instance_location so node dir resolves from INSTANCES_CONF): │
         │    • gnk_autostart_enable <net>   @reboot crontab autostart        │
         │    • gnk_watchdog_install         */5 node-sync watchdog           │
         │    • _install_grin_logrotate      /etc/logrotate.d/grin-node-<net> │
         │        copytruncate REQUIRED (grin holds log open, no SIGHUP       │
         │        reopen) — daily, size 50M, rotate 7, compress delaycompress │
         │    (gnk_* from lib/grin_node_keepalive.sh, sourced at top; all     │
         │     three steps idempotent; failures warn, don't abort)            │
         │                                                                    │
         │  Returns: 0 = both built ; 1 = cancel. Either → menu.              │
         └───────────────────────────────────────────────────────────────────┘
                                    │  (Super Auto path re-enters the same
                                    │   Steps 2→14 pipeline below, per-node)
                                    ▼
                    ┌───────────────▼───────────────┐
                    │  STEP 2 — System Update &     │
                    │  Dependency Check             │
                    │  must run as root             │
                    │  apt-get update + upgrade     │
                    │  (or dnf update on Rocky/Alma)│
                    │  apt install: tar openssl     │
                    │  libncurses tmux jq tor       │
                    │  curl wget                    │
                    └───────────────────────────────┘
                                    │
                    ┌───────────────▼───────────────┐
                    │   STEP 3 — Network Selection   │
                    │                                │
                    │   [slot free]  1=mainnet       │
                    │               2=testnet        │
                    │               3=both           │
                    │                                │
                    │   [RESTRICTED set from Step 1] │
                    │   1=install the other network  │
                    │   2=rebuild running mainnet    │
                    │     with different mode        │
                    │     (kill + clear mainnet conf)│
                    └───────────────────────────────┘
                                    │
              ┌─────────────────────┼──────────────────────┐
              │                     │                       │
           mainnet               testnet                  both
              │                     │                       │
              │                     │           setup mainnet first
              │                     │                then testnet
              └──────────┬──────────┘                    (loop)
                         │
                ╔════════▼═══════════════════════════════════╗
                ║       setup_one_node(network)               ║
                ╚═════════════════════════════════════════════╝
                         │
         ┌───────────────▼───────────────┐
         │   STEP 4 — Archive Mode       │
         │   1=pruned (~10 GiB)          │
         │   2=full archive (~25 GiB)    │
         │     (mainnet only)            │
         │   disk space warning if low   │
         │   [SUPER_AUTO] force pruned,  │
         │     skip prompt               │
         └───────────────────────────────┘
                         │
         ┌───────────────▼───────────────┐
         │   STEP 5 — Create Node Dir    │
         │   default: /opt/grin/node/    │
         │   e.g. mainnet-prune          │
         │        mainnet-full           │
         │        testnet-prune          │
         │   confirm if dir has files    │
         │   → rm -rf existing contents  │
         │   sets GRIN_DIR global        │
         │   skips disk check if         │
         │   GRIN_SKIP_DISK_CHECK=1      │
         └───────────────────────────────┘
                         │
         ┌───────────────▼───────────────┐
         │   STEP 6 — Download Binary    │
         │   GitHub API → latest release │
         │   linux-x86_64.tar.gz         │
         │   cached: reused if already   │
         │   downloaded for first node   │
         │   install to GRIN_DIR/grin    │
         └───────────────────────────────┘
                         │
         ┌───────────────▼───────────────┐
         │   STEP 7 — Generate Config    │
         │   ./grin server config        │
         │   backup if toml exists       │
         └───────────────────────────────┘
                         │
         ┌───────────────▼───────────────┐
         │   STEP 8 — Patch Config       │
         │   set archive_mode            │
         │   set db_root path            │
         │   set p2p port                │
         │     mainnet: 3414             │
         │     testnet: 13414            │
         └───────────────────────────────┘
                         │
         ┌───────────────▼───────────────┐
         │   STEP 9 — Chain Data Source  │
         │   scan zones (america/asia/   │
         │   europe/africa/all)          │
         │   check sync status of peers  │
         │   user picks server           │
         │                               │
         │   ┌─────────────────────────┐ │
         │   │ How to download?        │ │
         │   │ 1 = On-the-fly stream   │ │
         │   │ 2 = Full download first │ │
         │   │ 3 = Slow-sync (no data) │ │
         │   └─────────────────────────┘ │
         │   [SUPER_AUTO] force choice 1  │
         │     (stream) + zone "all",    │
         │     skip both prompts         │
         └───────────────────────────────┘
                         │
              ┌──────────┴──────────┐
              │                     │
     STREAM_MODE=true        STREAM_MODE=false
              │                     │
  ┌───────────▼──────────┐  ┌───────▼──────────────┐
  │  STEP 10 — Stream    │  │  STEP 10 — Download   │
  │  Extract (on-the-fly)│  │  .tar.gz + .sha256    │
  │  curl | tar -xz pipe │  ├──────────────────────-┤
  │  no local file saved │  │  STEP 11 — SHA256     │
  │  skips steps 11 & 12 │  │  verify checksum      │
  └──────────────────────┘  ├───────────────────────┤
                             │  STEP 12 — Disk check │
                             │  check space ≥ tar.gz │
                             ├───────────────────────┤
                             │  STEP 12 — Extract    │
                             │  tar -xz into GRIN_DIR│
                             └───────────────────────┘
              │                     │
              └──────────┬──────────┘
                         │
         ┌───────────────▼───────────────┐
         │   STEP 13 — Start in tmux     │
         │   session name:               │
         │   grin_full_mainnet           │
         │   grin_pruned_mainnet         │
         │   grin_pruned_testnet         │
         │   kill existing session first │
         │   if already exists           │
         └───────────────────────────────┘
                         │
         ┌───────────────▼────────────────────────────────────┐
         │   STEP 13b — Tor HiddenService  (IMPLEMENTED)      │
         │                                                    │
         │   _grin_torrc_install <network> <api_port>         │
         │                                                    │
         │   Writes marker-bounded block to /etc/tor/torrc:   │
         │     # >>> grin-toolkit:<network>-raw-tcp >>>            │
         │     HiddenServiceDir /var/lib/tor/grin-<net>-raw-tcp/   │
         │     HiddenServicePort 80 127.0.0.1:<api_port>      │
         │     # <<< grin-toolkit:<network>-raw-tcp <<<            │
         │                                                    │
         │   api_port:  3413 (mainnet)  13413 (testnet)       │
         │   Direct raw Foreign API — no nginx, no rate limit │
         │   Callers must supply foreign_api_secret           │
         │   P2P port not exposed                             │
         │                                                    │
         │   SEPARATE from Script 04's nginx-proxied onion:   │
         │     Script 01 → /var/lib/tor/grin-<net>-raw-tcp/        │
         │     Script 04 → /var/lib/tor/grin-<net>-nginx/     │
         │   Different .onion addresses, different purposes.  │
         │   Script 04 status page uses grin-<net>-nginx only.│
         │                                                    │
         │   Idempotent: compares existing block to expected; │
         │   no file write + no tor reload if identical.      │
         │   Tor keys in grin-<net>-raw-tcp/ are never deleted by  │
         │   any toolkit operation — .onion addr survives all │
         │   rebuilds.                                        │
         │                                                    │
         │   _grin_read_onion <network> [timeout]             │
         │   Polls hostname file up to timeout seconds, then  │
         │   prepends network prefix:                         │
         │     mainnet → main.grin.<56chars>.onion            │
         │     testnet → test.grin.<56chars>.onion            │
         │   (Tor v3 subdomain prefix — cosmetic label only,  │
         │    crypto identity is the 56-char hash)            │
         │                                                    │
         │   BACKUP & RECOVERY:                               │
         │     Backup:   cp -rp /var/lib/tor/grin-mainnet-raw-tcp/ │
         │                       /opt/grin/backup/tor-main-raw-│
         │                       $(date +%Y%m%d)/             │
         │     Restore:  systemctl stop tor                   │
         │               cp -rp backup/ /var/lib/tor/grin-…  │
         │               chown -R debian-tor:debian-tor …     │
         │               chmod 700 dir; chmod 600 keys        │
         │               systemctl start tor                  │
         │     New addr: rm -rf /var/lib/tor/grin-<net>-raw-tcp/   │
         │               systemctl reload tor                 │
         │               (torrc stanza must still exist)      │
         └────────────────────────────────────────────────────┘
                         │
         ┌───────────────▼───────────────┐
         │   STEP 14 — Summary           │
         │   network / mode / dir        │
         │   tmux session name           │
         │   elapsed time / log path     │
         │   onion URL (polls up to 20s) │
         │   backup reminder → script089 │
         │   recovery chown hint         │
         │   [SUPER_AUTO] show "autostart│
         │     /watchdog/logrotate being │
         │     configured"               │
         │   [custom] "autostart is      │
         │     offered next (Step 14c)"  │
         └───────────────────────────────┘
                         │
         ┌───────────────▼───────────────┐
         │   save_instance_location      │
         │   writes to conf/             │
         │   grin_instances_location.conf│
         │   key: PRUNEMAIN / FULLMAIN   │
         │        / PRUNETEST            │
         │   clears sibling mainnet key  │
         │   (PRUNEMAIN↔FULLMAIN mutual  │
         │    exclusion enforced here)   │
         └───────────────────────────────┘
                         │
         ┌───────────────▼───────────────┐
         │  [SUPER_AUTO only]            │
         │  _super_auto_harden(net,dir)  │
         │  runs AFTER save_instance_loc │
         │  so node dir resolves from    │
         │  INSTANCES_CONF:              │
         │  • gnk_autostart_enable       │
         │  • gnk_watchdog_install       │
         │  • _install_grin_logrotate    │
         │  (idempotent; warn on fail)   │
         ├───────────────────────────────┤
         │  [custom wizard: key 5, and   │
         │   key 4's full reinstall]     │
         │  Step 14c _offer_autostart    │
         │   [Y/n] → gnk_autostart_enable│
         │   (replaces the net's line,   │
         │    so a stale dir is fixed)   │
         │  Step 14d _offer_event_       │
         │   recorder (once per run)     │
         └───────────────────────────────┘
                         │
              ┌──────────┴──────────┐
              │  if NETWORK=both    │
              │  and mainnet done   │
              └──────────┬──────────┘
                         │
                  loop back to
              setup_one_node("testnet")
                         │
                  (same steps 4–14)
                         │
         ┌───────────────▼───────────────┐
         │   Press 0 to return to menu   │
         └───────────────────────────────┘


Key flows to highlight (menu keys; the as-built table is in script01_implementation.md):

1 / 2 (start / stop a node) — one network per pick, via s01_start_node / s01_stop_node. Stop
  names only that network's session (exact `-t "=name"`, root AND grin tmux servers) and only
  grin processes whose binary is that dir's; wallet sessions that share the `grin_` prefix are
  never touched. Start goes through gnc_launch_node_session (the node launch contract).

3 (binary update) — bypasses Steps 2–14. mainnet / testnet / both (default). Downloads once,
  then per node: stop → swap (old binary kept as grin.prev and archived under /opt/grin/bin) →
  start only if it was running. A stopped node is updated and left stopped. Never exits.

4 (rebuild a node) — pick network, then:
  • chain_data only: rebuild_chain_data_only — stop, refuse while a grin process of the dir
    lives, rm chain_data only, re-download + extract + start. Config, secrets, .onion kept.
  • full reinstall: typed REBUILD (DELETE-ARCHIVE when a full archive is among the dirs) →
    s01_full_reinstall — stop THAT node, delete its dirs and conf lines, setup_one_node for that
    network. The other network keeps running. This is also how mainnet switches pruned ↔ full.

5 (install) — only a network with no node dir. legacy-dir check → OS/deps → select_network
  (offers the free networks; typo re-prompts, 0 returns) → setup_one_node (twice for "both").

A (Super Auto — one-hit wipe & rebuild both) — run_super_auto. Inline, one process:
    1. Soft 20 GB disk gate (_super_auto_free_gb; < 20 → warn + FORCE override, else cancel).
       This gate replaces the per-node disk check → GRIN_SKIP_DISK_CHECK=1.
    2. State-aware confirm: destructive (running port OR installed node) → type REBUILD
       (DELETE-ARCHIVE if a full archive exists); clean box → [Y/n].
    3. Wipe: stop_grin_gracefully (= s01_stop_all) → _remove_instance_dirs all → truncate conf.
    4. check_os_and_deps → check_legacy_grin_dir → SUPER_AUTO=true →
       setup_one_node mainnet → setup_one_node testnet (both pruned + streamed).
  SUPER_AUTO=true suppresses the archive-mode prompt (forced pruned), the transfer-mode
  prompt (forced stream / choice 1), and the zone prompt (forced "all"). Per-node, after
  save_instance_location, _super_auto_harden adds @reboot autostart (gnk_autostart_enable),
  the */5 node-sync watchdog (gnk_watchdog_install), and copytruncate logrotate
  (_install_grin_logrotate). gnk_* come from lib/grin_node_keepalive.sh (sourced at top).
  Success or cancel → back to the menu. It wipes only the dirs the conf lists.

G (source build / rollback) — gsb_menu, lib/01_lib_source_build.sh. Stops ALL running nodes
  while it swaps a binary (known gap, see script01_implementation.md Open items).

"both" network — runs setup_one_node twice sequentially. Binary download cached after first run
  (reused for testnet). Each run independently saves to conf.


──────────────────────────────────────────────────────────────────────────────────────────────
I2P vs Tor — Research Note (I2P not planned)
──────────────────────────────────────────────────────────────────────────────────────────────

I2P (Invisible Internet Project) uses garlic routing (vs Tor's onion routing).
Compared for Grin P2P use:

  Feature              Tor                          I2P
  ───────────────────  ───────────────────────────  ───────────────────────────────────────
  Routing              Onion (3-hop, layered)        Garlic (bundled msgs, tunnel-based)
  Designed for         Clearnet anonymity +          Internal P2P network services
                       hidden services
  Exit nodes           Yes (clearnet leak risk)      No — all traffic stays in I2P
  P2P fit              Good                          Excellent (built for P2P apps)
  Grin support         Partial — grin-server.toml    None — needs Grin core changes
                       has socks_proxy_addr,
                       use_tor_listener, tor_external_addr
  Address format       .onion                        .i2p / b32.i2p
  SOCKS proxy port     9050                          4444 (I2P-only, no clearnet exit)
  Implementation       C (fast)                      Java (i2pd is C++ alternative)

Can Grin run on I2P?
  Theoretically yes, but NOT practical today:
  • Grin's P2P layer only understands IP addresses and .onion hostnames
  • .i2p / b32.i2p addresses are not recognised by Grin's peer handling code
  • Would require Grin core changes (like Bitcoin Core did in v22.0 for I2P via SAM bridge)
  • socks_proxy_addr cannot be reused — I2P SOCKS (port 4444) only routes to .i2p
    destinations, not clearnet; it is not a drop-in replacement for Tor SOCKS

Verdict: Tor is the practical choice now.
  I2P support is a Grin core feature request — not something the toolkit can configure
  without upstream changes. If Grin core ever adds I2P (following Bitcoin's lead),
  Step 14b can gain an I2P branch alongside the Tor branch above.

Reference: Bitcoin Core I2P docs — https://github.com/bitcoin/bitcoin/blob/master/doc/i2p.md
