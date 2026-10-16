# Script 01 — Build a New Grin Node: implementation

> **Covers code as of:** 2026-10-15 · **Last verified:** never systematically verified (written from the build record and a read of `lib/01_lib_menu.sh` and `lib/01_lib_node_table.sh`; the stub-harness result below describes the code, not this page)
> **Product code last changed:** 2026-10-15 — `scripts/01_build_new_grin_node.sh` split into an entry plus `scripts/lib/01_lib_*.sh`; new menu and node table, then menu groups + per-key target hints, autostart in the status line and the wizard's Step 14c autostart offer; `scripts/lib/grin_node_control.sh` (exact `=` session match); `scripts/081_host_monitor_port.sh` (remote stop snippet). Working tree at the time of writing.

**Status:** built, **not VPS-tested.** Behaviour was exercised only against a stub harness kept outside
the repo (it sources one lib with `tmux`/`ss`/`su`/`pgrep`/`kill`/`grin` replaced by shell functions
that print what they were asked to do): 188 assertions passed at the last run. A menu that has passed
stubs is not a tested menu.

Companion doc: [script01_reference_flowchart.md](script01_reference_flowchart.md) (the ENTRY/menu
flow and the Steps 2–14 pipeline). IPv6 → [script01_design_ipv6.md](script01_design_ipv6.md).

## 1. What shipped

### 1.1 Menu and keys

Script 01 opens on **one** status-first screen in every state: the node status block, a rule, then
fixed keys in three titled groups — *One-shot setup* (`A`), *Nodes* (`1`–`5`), *Source build* (`G`) —
and `0`. A key that can act shows the network(s) it would act on (`→ testnet`,
`→ both / mainnet / testnet`), taken from the same list the network picker offers; a key that cannot
act is printed dim with its reason, in the same column. A typo or a dim key re-prompts and never
leaves the script. Only `0` (or end of input) returns to the toolkit's main menu.

| Key | Action |
|---|---|
| `A` | Super Auto — wipe both nodes, rebuild both pruned (typed `REBUILD`) |
| `1` | Start a node |
| `2` | Stop a node (no rebuild) |
| `3` | Update Grin binary — mainnet / testnet / **both** (default) |
| `4` | Rebuild a node — `chain_data` only, or full reinstall of that network |
| `5` | Install a node on a network that has none yet |
| `G` | Compile Grin binary from source / roll back old Grin version (`lib/01_lib_source_build.sh`, unchanged) |
| `0` | Back to main menu |

Numbers are node actions; letters are advanced (`G`) or destructive (`A`). Hidden aliases for muscle
memory: `s`→1, `b`→3, `m`→4 on mainnet, `t`→4 on testnet. `k`, `c`, `n`, `r` are deliberately not
keys ("Unknown choice"): a foreign process on 3414/13414 is a red line in the status block, not a
menu, and 3415/13415 are wallet ports and never a node conflict.

Rules every key obeys: it touches **only the network it names**; "stop all" is a loop over the node
table, never a pattern sweep; no key empties the instances conf without deleting the matching dir;
every action ends with *Press Enter* and the next pass starts from `s01_reset_state` and a fresh scan.
`s01_reset_state` re-seeds `GRIN_BIN_TMP` from `GRIN_PREBUILT_BIN`, so a binary compiled with `G`
survives the reset and is the one the next install uses.

### 1.2 Node table

`s01_scan_nodes` (`lib/01_lib_node_table.sh`) is the single, read-only scan the menu and every action
share. Per network (`mainnet`, `testnet`) it fills `NT_*` arrays:

- **Directory** — a dir with a live grin process, else the conf-registered dir, else the first
  installed one (full before pruned), else a registered dir that is gone. A second installed dir for
  the same network is reported as `NT_EXTRA` ("also on disk").
- **Installed** = `grin-server.toml` **and** an executable `grin` in the dir.
- **Running** = a grin process whose *binary* is `<dir>/grin` — not "the port is bound", so a node
  still booting (lock held, 3414 not yet listening) counts as running.
- **Session** — which tmux server holds the node's session: `gtmux` (grin user), `root tmux`, or none.
- **Conf verdict** — the instances conf is parsed line by line (never `source`d) and compared with the
  scan; mismatches print a yellow line. The scan goes by disk, so a conf that lost its entries does not
  hide a node.
- **Foreign holder** of the P2P port (a non-`grin` process on 3414/13414) → red line; its pid is never
  signalled.
- **Autostart** — the network's tagged `@reboot` line in root's crontab (the tag Script 03 → G and
  `gnk_autostart_enable` both write), read once per scan: `autostart ✓` when its `cd '<dir>'` is the
  scanned dir, `autostart ✗` plus a yellow line when it starts another dir (what a pruned↔full rebuild
  leaves behind), `autostart —` when there is none. A line left for a network with no node is shown
  under "not installed".

### 1.3 Per-node actions

All in `lib/01_lib_node_table.sh` unless noted. Each takes one network and never names the other one
or a wallet session.

- `s01_stop_node <net>` — for each dir of the network with a live process: planned-stop marker →
  SIGTERM (`stop_grin_one <port> <dir>`) → its own session killed on **both** tmux servers → leftovers
  of *that dir* swept. Session names are exact (`-t "=name"`).
- `s01_stop_all` — `s01_stop_node` for every running network. It is the body of `stop_grin_gracefully`,
  which Super Auto and key `G` still call.
- `s01_start_node <net>` — starts from the scanned dir through `gnc_launch_node_session` (the launch
  contract: `grin` user, `HOME=<dir>`, chown, both-socket pre-kill, gtmux). An orphan (process, no
  session) is cleared first. A launch failure is **reported and returned, never `die`d**, so callers
  that loop over nodes keep going. Sets `S01_LAST_START` = `launched` | `running` | `failed`.
- `update_binary_only <both|mainnet|testnet>` (`lib/01_lib_node_ops.sh`) — downloads the release once,
  then per node: stop → swap → start **if it was running**. A node that was stopped gets the new binary
  and stays stopped. With two nodes the second waits `GRIN_STAGGER_SECS` before it is stopped, so it
  keeps serving through the gap. The replaced binary is kept as `<dir>/grin.prev` and archived under
  `/opt/grin/bin`; a failed `install` restores `grin.prev`. It returns; it never exits the script.
- `rebuild_chain_data_only <net> <dir>` (`lib/01_lib_node_ops.sh`) — stops the node, **refuses while a
  grin process of the dir still exists**, removes only `chain_data`, re-downloads and starts. Config,
  secrets and `.onion` are kept. Its `rm -rf` is guarded to dirs under `/opt/grin/node/`.
- `s01_full_reinstall <net>` — stop that node, delete its dirs under `/opt/grin/node/` (a dir outside
  that root is left in place with a warning), clear that network's conf lines, then run the wizard
  (`setup_one_node`) for that network only; mainnet asks pruned/full at Step 4. The caller owns the
  typed confirmation. API secrets (key vault) and the `.onion` identity survive.

### 1.4 File layout

Entry `scripts/01_build_new_grin_node.sh` keeps the header, globals, colours, logging, `die`,
`step_header`, the `source` lines and `main`. Its path and name are a contract: the toolkit's main
menu, solo mining (`07_grin_mining_solo.sh`) and Script 03's hint all launch it. `main` = root check →
`flock` → `s01_menu_loop`.

| File | Lines | Holds |
|---|---|---|
| `01_build_new_grin_node.sh` | 334 | entry (above) |
| `lib/01_lib_menu.sh` | 336 | `s01_reset_state`, `s01_menu_loop`, `s01_pick_net`, `s01_act_{start,stop,update,rebuild,install}` |
| `lib/01_lib_node_table.sh` | 353 | `s01_scan_nodes`, `s01_render_status`, `s01_stop_node`/`s01_stop_all`, `s01_start_node`, `s01_full_reinstall` |
| `lib/01_lib_node_ops.sh` | 541 | `stop_grin_gracefully`, `stop_grin_one`, `_remove_instance_dirs`, stagger helpers, `update_binary_only`, `rebuild_chain_data_only`, `detect_installed_nodes`, `_describe_installed_node` |
| `lib/01_lib_super_auto.sh` | 243 | `run_super_auto` and its helpers (disk gate, logrotate, hardening, event-recorder offer) |
| `lib/01_lib_wizard.sh` | 453 | legacy-dir check, OS/deps, swap/tuning, `select_network`, `select_archive_mode`, `setup_one_node` |
| `lib/01_lib_node_config.sh` | 493 | node dir, binary download, `generate_config`, `patch_config`, secrets, `ensure_grin_user` |
| `lib/01_lib_chain_data.sh` | 747 | mirror/zone discovery, `download_chain_data`, checksum, disk check, (stream) extract |
| `lib/01_lib_node_launch.sh` | 331 | `start_grin_tmux`, `show_summary`, `save_instance_location`, Tor onion helpers |
| `lib/01_lib_source_build.sh` | 1,046 | key `G` — unchanged by the menu work |

Wizard Steps 4–14 (mode, dir, binary, config, secrets, chain data, start, Tor, save conf), the launch
contract, `lib/01_lib_source_build.sh` and its rollback, Super Auto's typed tokens (`REBUILD`,
`DELETE-ARCHIVE`) and the mainnet/testnet start stagger were deliberately left as they were.

Shared files touched: `lib/grin_node_control.sh` (`gnc_has_grin_session` / `gnc_kill_grin_session` use
the exact `-t "=name"`) and `081_host_monitor_port.sh` (its remote stop snippet matches by
`pgrep -x grin` plus a cmdline check instead of a final pattern kill).

## 2. Runbook

**Keys by state** (what the status block lets each key do):

| State | 1 Start | 2 Stop | 3 Update | 4 Rebuild | 5 Install |
|---|---|---|---|---|---|
| **Both running** | dim — already running | picker | picker, default *both* | picker | dim — no free network |
| **One running** | dim for that net; starts the other if installed | auto-picks the running net | picker if both installed (default *both*), else that net | picker / auto | offers the free network only |
| **Installed, none running** | picker | dim — nothing is running | picker | picker | dim |
| **Fresh** (nothing on disk) | dim | dim | dim | dim | mainnet / testnet / both |
| **conf ≠ disk** | by disk, yellow line shows | by disk | by disk | uses the disk dir | dim while the dir exists |
| **Broken dir** (binary or config missing) | dim — "<net> broken — repair with 4" | unaffected | skips that net | that net: full reinstall only; hint says so | dim while the dir exists |
| **Foreign process on 3414/13414** | stays live; the start will fail to bind (red status line is the only hint) | unaffected | unaffected | unaffected | unaffected |

- **Key 1** starts **one** network per pick, then warns to let it finish booting when the other
  network is installed and stopped. Starting both takes two picks.
- **Key 3** on a stopped node swaps the binary and leaves the node stopped; key 1 starts it.
- **Key 4** asks `1` chain_data only (typed `REBUILD`) or `2` full reinstall. A full reinstall prints
  exactly what it deletes and needs `REBUILD`, or `DELETE-ARCHIVE` when a full archive is among the
  dirs. A node whose binary or config is missing offers only the full reinstall. Changing mainnet
  between pruned and full is a full reinstall of mainnet (Step 4 asks); testnet keeps running.
- **Key 5** runs legacy-dir check → OS/deps → `select_network` (free networks only) → `setup_one_node`.
  After each node's summary, Step 14c asks "Start this node automatically after a reboot? [Y/n]"
  (default yes, EOF declines) and calls `gnk_autostart_enable` — mainnet 5 s, testnet 1000 s. It
  replaces the network's line, so on key 4's full reinstall it also re-points a line still naming the
  old dir; the prompt says so when that is the case. Step 14d is the event recorder offer.
- **Key A** — wipes **both** nodes and rebuilds both pruned and streamed, with autostart, watchdog,
  event recorder and logrotate. It returns to the menu when done.
- **Key G** stops **both** nodes while it swaps a binary (see Open items).
- **A box that ran the old `K`** (conf emptied, dirs left on disk): the scan still finds the nodes by
  disk and prints the conf mismatch; nothing refills the conf until the next install or full reinstall
  of that network rewrites it.

**Checking a state by hand** (as root): `gtmux ls`, `tmux ls`, `ss -tlnp | grep 414`; the conf is
`/opt/grin/conf/grin_instances_location.conf` and must be unchanged by keys 1, 2 and 3.

## 3. Build notes — obstacles & lessons

### Binary update / stop sweeps
#### A node binary update closed the pool wallet's tmux session
**Symptom, cause, shared-lib fix:** see the twin note of the same title under *Payments* in
[script07_implementation.md](script07_implementation.md). **Script 01's half:** its stop path killed
by pattern, so any `^grin_` session — the pool wallet's included — died with the node. **Fix:** every
stop names one network's session exactly and kills only grin processes whose binary is that dir's
(`s01_stop_node`); the 081 remote stop snippet matches `pgrep -x grin`. Uncommitted at writing.
**Lesson:** a shared name prefix is not a type; and a node update is verified by listing the *other*
tmux sessions afterwards, not by the node coming back.

### Node registry
#### K emptied the node registry
**Symptom:** after the old menu's `K` (stop all, "rebuild"), the instances conf was empty but the node
dirs were still on disk; later actions found no session or process to stop and the wizard judged the
network as new. **Cause:** `K` stopped the nodes and truncated the conf without deleting the matching
dirs, and every lookup trusted the conf. **Fix:** `K` is gone; the node table scans conf, disk, process
and session together and prints any mismatch; the rebuild paths delete the dir and its conf lines
together. **Lesson:** a registry and the thing it registers change in the same step, and a scan that
trusts only the registry goes blind exactly when the two diverge.

### Mode switch
#### A mainnet mode switch stopped testnet
**Symptom:** switching mainnet between pruned and full at wizard Step 3 took the testnet node down
too. **Cause:** that option called stop-all. A sibling bug sat under it: `stop_grin_one` returned early
when nothing listened on the port, so a node still booting (lock held, port unbound) was never
stopped and a following `rm -rf` could run under it. **Fix:** the option is removed (the switch is
key 4 → full reinstall of that network); `stop_grin_one` always runs the session kill and the dir sweep,
takes the node dir from its caller, and signals the port holder only if it is a grin process of that
dir; `rebuild_chain_data_only` refuses while a grin process of the dir exists. **Lesson:** an action that deletes names its target and proves it is dead
first; "stop all" is a loop over the table.

### Menu exits
#### "0" inside an action quit Script 01
**Symptom:** answering `0` at a wizard prompt (legacy `~/.grin`, archive mode, existing archive or
chain_data, no live mirror), `n` to the low-disk warning, or `0` after an error dropped the operator at
the toolkit's main menu instead of the Script 01 menu. **Cause:** those prompts date from the linear
wizard and call `exit 0` (`die` exits too); inside the menu loop that ends the whole script. An unbound
variable under `set -u` did the same, since it exits whatever errexit says. **Fix:** `s01_run_action`
runs each action in a subshell, so any exit ends only the action; inside it `die` offers only "back to
the Script 01 menu" (its `exec "$0"` retry would fail the flock the parent holds). Every cancel (`0`,
Enter at a typed token, `n`) returns or exits with `S01_RC_BACK`, and the loop skips its "Press Enter"
pause for that status, so one key gets the operator back. The same errexit-off context meant a bare
command in a wizard step failed silently, so the binary `install`, the `patch_config` seds and the
registry write in `save_instance_location` now `die` on failure. Uncommitted at writing. **Lesson:** a loop
wrapped around old linear code inherits every `exit` in it — contain them, don't hunt them one by one.

## 4. Open items

- **Not VPS-tested** — nothing in this doc has run on a VPS. Acceptance order: `bash -n` on the entry and
  every `lib/01_lib_*.sh`; testnet first; each reachable state (both running · one running · installed
  none running · fresh) with each key; with the pool wallet running, `2`→testnet then `3`→mainnet and
  confirm `grin_pubpoolwallet` is still listed on `tmux ls`/`gtmux ls` and testnet returns after the
  mainnet update; conf unchanged after `1`/`2`/`3`; `4`→mainnet full reinstall only when a pruned↔full
  switch is actually wanted (long sync).
- **Wizard runs with errexit ignored.** `main` calls `s01_menu_loop || true`, so bash disables `set -e`
  for the whole menu, wizard included. Wizard Steps 4–14 still rely on it: `install -m 755` in
  `download_grin_binary` can print *success* after failing, and `patch_config`'s `sed -i` lines can fail
  silently, leaving a node to start on an unpatched toml. Needs a decision: add `|| die` to the unguarded
  wizard file ops (smaller), or call the menu bare and drop the guards around it.
- **Key `G` stops both nodes.** Its install and rollback call `stop_grin_gracefully` (= stop all) and
  restart through `start_grin_tmux`, which can `die`, with no stagger. Intended: stop and start only the
  instance it installs into, through `s01_stop_node`/`s01_start_node`.
- **Wizard prompts that still leave the script.** `check_legacy_grin_dir`, `select_archive_mode` and the
  disk-space prompt `exit 0` on "0", and a typo at Step 4 hits `die` instead of re-prompting
  (`lib/01_lib_wizard.sh`, `lib/01_lib_chain_data.sh`). After key 4 → full reinstall the network is
  already deleted when they fire.
- **Conf cleared for a dir that was kept.** `s01_full_reinstall` leaves a dir outside `/opt/grin/node/`
  in place but still deletes that network's conf lines, and `_remove_instance_dirs` clears the conf even
  when its `rm -rf` failed. If the wizard then dies, the kept dir is invisible to the scan.
- **A grin of another dir on the P2P port is not flagged.** `_nt_port_foreign` treats any binary named
  `grin` as ours, so such a node shows the network STOPPED with no red line; `s01_act_start` warns nothing
  when a foreign holder exists.
- **Super Auto wipes only conf-listed dirs.** On a box whose conf was emptied by the old `K`, "wipe all"
  deletes nothing and rebuilds into the old dirs. Intended: reuse `s01_full_reinstall`'s scan-based removal.
- **Key `3` on a stopped node never offers to start it** — key 1 is the only way.
