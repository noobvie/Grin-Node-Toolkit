# Script 086 — Diagnostics & Support Bundle

> **Covers code as of:** 2026-09-25 for §1–7 · 2026-10-03 for §8.1–§8.14 (DESIGN, written
> before the code against `grin_node_control.sh`, `grin_node_keepalive.sh`, `086_lib_diag.sh`
> and `082_provider_access_watch.sh` as committed at `65d5061`; §8.5 and §8.13 also carry the
> Part 1 decisions). Parts 1–5 and the R1 fixes are built, uncommitted and never run; where the
> build differs, the as-built record wins: it moved to
> [`script086_implementation.md`](script086_implementation.md) §8.15–§8.22 on 2026-10-03 ·
> **Last verified:** 2026-10-03, PARTIAL — §8 only, by the R1 review (implementation §8.19):
> §8.2's read-only gate by grep, §8.4/§8.5's transitions and §8.10's debounce by a local harness
> over the pure functions. Nothing installed or run on a VPS; §1–7 never systematically verified
> **Product code last changed:** 2026-10-03 — `scripts/086_grin_diagnostics.sh` (key 7: recorder
> sub-menu; support bundle file 10), `scripts/lib/086_lib_recorder.sh` (new: the recorder's read
> side), `scripts/01_build_new_grin_node.sh`, `scripts/08del_clean_all_grin_things.sh`,
> `scripts/089_backup_restore.sh` (recorder lifecycle), `scripts/lib/grin_node_events.sh` (new: recorder core
> + evidence + alerts), `scripts/lib/grin_alert_send.sh` (new: alert delivery, extracted from
> `082_provider_access_watch.sh`, which now inlines it), `scripts/lib/grin_log_signatures.sh` (new: the signature table, moved out of
> `086_lib_diag.sh` unchanged), `scripts/lib/086_lib_diag.sh` (now sources it),
> `scripts/lib/grin_node_keepalive.sh` (the watchdog hook); 2026-09-25 — `scripts/086_grin_diagnostics.sh`

**Status:** built 2026-09-25, **never run on a VPS.** Only `bash -n` and a local test of the
log-triage and TOML-flattening functions on sample data have run.
**Menu:** hub 08, key `6`.
**Files:** `scripts/086_grin_diagnostics.sh` (menu, rendering, bundle),
`scripts/lib/086_lib_diag.sh` (probes, log triage, collectors),
`scripts/lib/grin_log_signatures.sh` (the log signature table, shared with the §8 recorder),
`scripts/lib/086_lib_recorder.sh` (key 7's read side of the §8 recorder). The recorder's own
files and its as-built record are in [`script086_implementation.md`](script086_implementation.md).

---

## 1. Why it exists

A run of node-side errors appeared around grin 5.5.1: explorers slow, `hyper::Error(IncompleteMessage)`
in the node log, and high iowait on an archive host. Nobody could say quickly whether the cause was
toolkit code, the host, or upstream grin. Each investigation began from scratch, with ad-hoc
commands pasted into a chat. One went wrong because the commands hard-coded `mainnet-full` on a host
that only had `mainnet-prune`.

086 makes that first step one menu key. It gathers the evidence, and it tags each finding with a
**likely origin** so the operator knows where to look first.

It follows the repo rule to **confirm root cause before editing**. The origin tag is a lean taken
from a pattern: a log signature or a threshold. It is never a verdict, and every summary says so.

## 2. Menu

| Key | Action | Changes anything? |
|-----|--------|-------------------|
| 1 | Quick health check (~30 s, on screen) | no |
| 2 | Build support bundle (~3 min, one `.tar.gz`) | no |
| 3 | Node API performance — `get_block` cold/warm and a 20-way burst | no, unless the IncompleteMessage experiments are accepted. Those add 1–2 lines to the node log |
| 4 | Node log triage — signatures and hourly timeline, window 1 h / 6 h / 24 h / since start | no |
| 5 | Consumer load test — node CPU/IO with explorers running, stopped, then restarted | **yes** — stops the read-only explorers for ~1 min, after a typed `yes` |
| 6 | Saved reports — list, delete older than N days | deletes only its own report files |
| 7 | Node event recorder (§8) — timeline, availability, evidence, export, alerts, install | only its install/remove, `recorder.conf`, and a new evidence bundle on request |

Reports go to `/opt/grin/reports/diag/`, which is mode 700; each report file is mode 600.

## 3. Likely-origin taxonomy

| Origin | Means "look at…" |
|--------|------------------|
| `host` | the VPS: disk pressure, RAM/swap, CPU steal, clock, filesystem full, OOM |
| `toolkit` | our setup: launch contract (root-run, HOME, duplicate node), secrets, services |
| `upstream` | grin itself: panics, or a binary replaced under a running node |
| `client` | programs calling the node API (IncompleteMessage, other API server errors) |
| `chain` | chain data on disk (corruption, LMDB) |
| `network` | P2P / sync (peers, lag vs public reference) |
| `config` | `grin-server.toml` (Debug logging, unauthenticated Owner API) |
| `consumer` | a toolkit service that uses the node (failed or crash-looping unit, stratum) |

## 4. Design decisions

- **Nodes are discovered from running processes** (`pgrep -x grin` + `/proc/<pid>/cwd`), never
  from a hard-coded dir. A node registered in `grin_instances_location.conf` but not running
  is reported separately (`gnc_resolve_node_dir`, conf-only).
- **Log triage is first-match-wins over an ordered signature table.** Specific causes come
  before generic words like "peer". The regexes are lower-case and mawk-safe, with no `{n}`
  intervals. Rotated `.gz` logs are read only if their mtime falls inside the window.
  Backtrace continuation lines follow the timestamped line above them.
- **Severity per signature:**
  - A panic, disk-full, permission, node-lock, OOM or fd-limit line is CRIT on first sight.
  - Chain-corrupt is only WARN, because a peer's bad block during sync produces the same
    words. `resource temporarily unavailable` is deliberately not a signature: it is ordinary
    P2P EAGAIN noise, not a lock.
  - IncompleteMessage and other API errors are WARN only above 20 per hour.
  - P2P, sync and stratum lines are WARN only above 600 per hour.
- **`grin-server.toml` is compared with what the SAME binary generates as its default.** This
  answers "did our config cause it?" directly.
  - The default is produced by `grin [--testnet] server config`, run as the `grin` user.
  - It runs in a throwaway dir with `HOME` set to that dir, so it follows the launch contract
    and writes nowhere near the node.
  - The comparison is key by key, on `section.key = value` lines.
- **Peers by user agent** (`get_connected_peers`) show which grin versions the node is talking
  to. This matters when a fault lines up with a version rollout on the network.
- **Every Owner API check includes the control call.** A deliberately wrong secret must be
  rejected, or a 200 proves nothing. This is the same rule as `_gns_probe_secret`.
- **401 detection in service journals counts only lines that mention the node.** Examples are
  `node`, `foreign`, `owner`, `:3413` and `/v2/`. A pool's own admin-login 401s would
  otherwise read as a stale node secret.
- **The consumer load test only touches `DG_READONLY_CONSUMERS`.** Those are
  `grin-tiny-explorer` and `grinscan-main`, the mainnet readers. The test measures the
  mainnet node, so pausing `grinscan-test` would be downtime that measures nothing. Pausing the pool or a wallet is
  an outage, not a measurement.
  - Units are restarted from the EXIT trap as well.
  - The test block writes through `> >(tee …)`, not `| tee`. A pipeline would run it in a
    subshell, and the trap would never learn which units were stopped.
- **Zero findings is reported as a broken run, never as a pass.** This is the same rule as 083.

## 5. Privacy

- No secret value is printed or placed on a command line. curl reads `user = "grin:…"` from
  stdin with `-K -`.
- IPv4 addresses are masked to /24; IPv6 to the first three groups.
- Strings of 20+ characters from `[A-Za-z0-9+=]` are redacted. Paths survive, because `/`
  is not in that set.
- **Hostnames and domains are not masked.** The bundle screen warns about this before the
  operator shares the file.
- `GRIN_DIAG_OFFLINE=1` skips the calls that leave the box: the public reference tip and the
  GitHub latest-release lookup.

## 6. Menu change in hub 08

Key `6` was the inline **Top 20 Bandwidth Consumers**. That screen moved unchanged into
**084 Nginx Extended Features** as option `5`, since it parses nginx access logs, which is
084's remit. Key `6` changed hands, so under the repo rule there is **no alias arm** for its
old meaning.

## 7. Open items

- Run it on a real VPS, pruned and archive. Until then, the thresholds are untested heuristics.
- The signature table is built from known failure modes, not from a corpus of 5.5.x logs. Add
  signatures as real bundles come in.
- There is no off-box upload by design. The operator copies the `.tar.gz` themselves.

---

## 8. Node event recorder — DESIGN 2026-10-03 (Parts 1–5 built and R1-reviewed, never run; as-built → `script086_implementation.md` §8.15–§8.22)

### 8.1 Why it exists

grin **5.5.1** has failed three ways on the operator's boxes:

1. The process gets stuck, then exits.
2. The API times out while the process is still alive.
3. chain_data corrupts suddenly. On 2026-09-30 the kernel PMMR failed `verify` under both
   protocol versions after an unclean stop.

Nobody can say when these failures happen, how often, or why. The existing tools cannot answer
that. The node-sync watchdog (`lib/grin_node_keepalive.sh`, cron every 5 min) restarts a node, and
its restart **kills the tmux pane that held the panic text**. 086's menu keys look at the box only
when someone runs them. The pool (§20 of `script07_design.md`) runs as `grinpool` on mainnet only,
and cannot read grin's log, the pane or the kernel log.

The recorder fills that gap. It is a **read-only** observer on every node box. It records each
down/up transition per network, keeps planned stops out of the outage count, and saves evidence at
the moment of failure. It can send off-box alerts. Its operator UI is a sub-menu of 086.

The goal is twofold: evidence good enough for an upstream grin issue, and an honest availability
record.

### 8.2 What the recorder must NEVER do

These are review gates. Any hit is CRITICAL.

- **Never start, stop, restart, kill or signal a node.** Restarting stays the watchdog's job. The
  recorder records what the watchdog did; it does not compete with it.
- **Never write into a node dir.** It may *read* `.grin_last_exit`, `.grin_last_start`,
  `grin-server.toml`, the log and `chain_data/txhashset/*` sizes. It must never chown, touch,
  truncate or delete anything there.
- **Never start a tmux server.** It may run only `has-session` and `capture-pane`, and only after
  `dg_tmux_capture`'s guard (the socket exists and is grin-owned). Running tmux as root on a stale
  grin socket makes a root server squat there, after which every node start fails (see `gtmux`).
- **Never run the grin binary in a node dir or as root with the node's HOME.** `grin --version` runs
  as `grin` in a throwaway dir with `HOME` set to that dir. Its result is cached per binary path and
  mtime.
- **Never put a secret in argv.** The Owner API probe feeds `user = "grin:…"` to curl on stdin
  (`-K -`), as 086 already does. It must NOT use `gnc_owner_get_status`, which passes
  `-u grin:$secret` on the command line. Every 30 s, that would put the owner secret in
  `/proc/<pid>/cmdline` for up to 8 s (see §8.13 F-3).
- **Never put log text, peer IPs or secrets** in `ledger.jsonl`, `status.json` or an alert. The
  only log text that ever leaves the evidence dir is the ONE matched signature line, inside an alert
  body.
- **Never delete outside `/opt/grin/node-events/`.** Its own pruning touches only `evidence/` and
  consumed planned-stop markers.
- **Never change watchdog config or state.** The coupling is one-way: the watchdog calls
  `grin-node-events capture` (§8.9).
- **Never need the network** for a check. Only alert delivery goes off-box.
- **Never source an untrusted file.** `recorder.conf` is parsed as `KEY=VALUE` lines against an
  allow-list of keys, not `source`d. Importing channels from 082 copies allow-listed keys only and
  never sources `alert.conf`.

### 8.3 Inputs, gathered per network per check

| Input | Source | Notes |
|---|---|---|
| `boot_id` | `/proc/sys/kernel/random/boot_id` | Compared with `status.json.boot_id`. |
| `btime` | `/proc/stat` | Used to turn process start ticks into an epoch. |
| `node_dir` | `gnc_resolve_node_dir <net>` | CONF-ONLY. Absent → state `unregistered`, never an outage (Script 01 removes a net from the conf mid-rebuild). |
| `pid` | `/proc/*` scan: `readlink -f /proc/<pid>/exe` = `node_dir/grin` (`comm` = `grin`) | **`exe` is required, not optional.** Matching on cmdline or cwd is NOT enough: the tmux SERVER started by the `@reboot` line has argv `tmux new-session … <dir>/grin server run` and cwd = the node dir. Fact-finding on 2026-10-03 (vps152623) showed `pgrep -f 'grin server run'` returning the tmux server (parent `/sbin/init`) next to the real grin pid. `gnc_kill_grin_procs` matches cwd OR exe, so it also TERMs that server; that is harmless on a stop path and fatal for a "which pid is the node" question. **Not** "PID on the API port" either: during 5.5's heavy init the port is not bound yet, and a port-only lookup would call a starting node "gone". The port lookup is a fallback only. |
| `pid_start` | `/proc/<pid>/stat` field 22 ÷ `CLK_TCK` + `btime` | Parse after the LAST `)`. Field 2 (`comm`) may contain spaces or parens. |
| `api` | one Owner `get_status`, 8 s max | Result KIND: `ok` (parsed `result.Ok`) · `timeout` (curl rc 28) · `refused` (rc 7) · `auth` (HTTP 401/403) · `bad` (any other HTTP code, non-JSON, envelope error, `Err`) · `no_secret` (unreadable `.api_secret`). |
| `last_start` | `<node_dir>/.grin_last_start` (`ts=<epoch>`) | Written by the node's tmux pane (`_gnc_node_run_cmd`, Part 1): launcher starts AND `@reboot` lines written after Part 1. Absent on nodes started before Part 1, by an `@reboot` line not re-enabled since (§8.13 F-1), or by 081's remote start. |
| `last_exit` | `<node_dir>/.grin_last_exit` (`ts=<epoch> rc=<n>`) | **Valid only if `ts ≥ last_start.ts`**, so that it belongs to the latest run. |
| `marker` | `/opt/grin/node-events/<net>/planned_stop` | See §8.5. |
| `autostart_delay` | the root crontab line tagged `grin_autostart_<net>` → `sleep N` | Read-only. No line → the net does not autostart after a boot. |
| previous | `status.json` | State, strikes, pid, last_ok, open outage. |

### 8.4 State machine

**States** (per network):

| State | Meaning | Downtime? |
|---|---|---|
| `up` | the last check got `get_status` `Ok` | no |
| `starting` | a start is in progress: a new pid whose API is not answering yet, still inside `start_timeout_min`. Also the post-boot window before autostart fires | no |
| `stopped` | a planned stop: the pid went away under a valid marker, or the box booted with no autostart for this net | no |
| `down` | a counted outage, carrying a `class` | **yes** |
| `auth_fail` | the API answers 401/403. The node is fine and a secret is wrong | no — shown as a fault |
| `unregistered` | the net is not in the instances conf, or it is disabled in `recorder.conf` | n/a |
| `unknown` | the recorder could not judge: first run, `no_secret`, or a clock anomaly | no |

**Strike rule.** One failed check is NOT an outage. `down` needs `down_strikes` consecutive failed
checks (default **2** at a 30 s cadence, so DOWN is declared within 30–60 s). The outage's
`started_at` is **backdated to the first failed check**, not the one that tipped it. A failed check
records `strikes` and `first_fail_ts` in `status.json`. An `ok` resets them to 0 / null.

**Failed check** = `api ∈ {timeout, refused, bad}` while NOT in `starting`, or the pid went away
with no marker. `auth` and `no_secret` are never failures.

**Transitions** (evaluated top to bottom, first match wins; `gne_decide` is this table as a pure function):

| # | From | Observation | To | Event written | Counted? |
|---|---|---|---|---|---|
| 1 | any | `boot_id` changed | `starting` if autostart exists for the net, else `stopped` | `boot` (plus `up` closing any open outage at `btime`, see below) | no |
| 2 | any | net not in conf / disabled | `unregistered` | `unregistered` (once) | no |
| 3 | any | `api = ok` | `up` | `up` if the previous state was not `up` (carries `duration_s` when it closes an outage) | — |
| 4 | any | `api = auth` | `auth_fail` | `auth_fail` (once); `auth_ok` when it clears | no |
| 5 | any | `api = no_secret` | `unknown` | `probe_error` (once) | no |
| 6 | `up` | pid gone, valid marker (§8.5) | `stopped` | `stop` (`by`, `reason`) | no |
| 7 | `up` | pid changed (new pid, not gone), marker or a pending watchdog capture | `starting` | `start` (`by`) | no |
| 8 | `up` | pid gone or changed, no marker, no watchdog capture | strike → `down` | `down` (class from §8.6) | **yes** |
| 9 | `up` | pid alive, `api ∈ {timeout, refused, bad}` | strike → `down` | `down` (`hung`) | **yes** |
| 10 | `starting` | pid alive, API not answering, `now − start_ref < start_timeout_min` | `starting` | — | no |
| 11 | `starting` | `now − start_ref ≥ start_timeout_min`, OR the pid exited before the first `ok` since this start | `down` | `down` (`failed_start`) | **yes** (backdated to `start_ref + start_timeout_min`, or to the exit) |
| 12 | `stopped` | a new pid appears | `starting` | `start` (`by`: marker / watchdog / `unknown`) | no |
| 13 | `stopped` | still no pid | `stopped` | — | no (a planned stop has no time limit) |
| 14 | `down` | still failing | `down` | — | open outage continues |
| 15 | `down` | new pid (a watchdog or operator restart) | `down`, sub-state `restarting` | `start` | the **same** outage stays open until rule 3 |
| 16 | `starting` | boot window: no pid yet, `now − btime < autostart_delay + start_timeout_min` | `starting` | — | no |

- **`start_ref`** = the latest of `pid_start`, `last_start.ts` and (after a boot) `btime + autostart_delay`.
- **`start_timeout_min`** defaults to **30**. The watchdog's post-restart grace is 20 min. This
  default is PROVISIONAL until fact-finding measures real 5.5.1 start times on pruned and archive
  nodes (checklist item A3).
- **A boot closes any open outage at `btime`**, recording its duration. The boot window is then
  excluded. If the node is not `up` by the end of the window, rule 11 opens a NEW outage
  (`failed_start`). A down node fixed by a reboot therefore counts the time up to the reboot and no
  more.
- **A boot records how the previous boot ended.** `clean_shutdown: true | false | null` comes from
  `journalctl -b -1` ending in a systemd shutdown target, falling back to `last -x`. It is computed
  once per boot. An unclean host stop while the node was `up` is exactly the precursor of the
  2026-09-30 PMMR corruption, so it is flagged (§8.10), though never counted as a node outage.
  The method was checked against real data on 2026-10-03 (vps152623). Clean boots end in
  `systemd-shutdown[1]: Syncing filesystems…`, and wtmp has a matching `shutdown` record. The boot
  ending 2026-07-17 14:48 ends on ordinary cron lines and has no wtmp shutdown record, so it was an
  unclean stop (crash or hard reset). Both sources agree.
- **One outage spans watchdog restarts.** A node in a restart loop is one outage with N
  `restart_by_watchdog` events, not N outages.
- **`up_since`** = the later of `pid_start` and the end of the last counted outage. It is continuous
  availability, not process age: a 10-minute hang resets it even though the PID survived. A planned
  restart resets it too, through `pid_start`.
- **Clock anomalies.** If `now < last_check`, or the gap since `last_check` exceeds
  `gap_factor × cadence` (default 10 × 30 s) with the same `boot_id`, the recorder writes a `gap`
  event (`observed_gap_s`). That interval counts as neither up nor down: it is **unobserved**.
  Durations are clamped at ≥ 0. Strikes reset after a gap, because two failures five minutes apart
  are not "consecutive".

### 8.5 Planned stops — the marker contract (Part 1 writes, the recorder reads)

`/opt/grin/node-events/<net>/planned_stop` is one line, written atomically (temp + `mv`) BEFORE the kill:

```
ts=<epoch> by=<caller script basename> pid=<grin pid at write time, or 0> reason=<optional, ≤80 chars>
```

- **It is written only when there is something to stop.** That means a live grin pid for that net,
  or a session on either socket. `gnc_launch_node_session` itself calls `gnc_kill_grin_session` on
  every start (§8.13 F-2), so an unconditional write would leave a marker on every start of an
  already-stopped node.
- **It is written only once the recorder is installed** (`/opt/grin/node-events/` exists). The
  writer creates `<net>/` (0755) but never the root, so `gne_install` (Part 2) must create
  `/opt/grin/node-events/` 0755. Before that, every stop path is a silent no-op.
- **`<net>` comes from the session name** (`*testnet*` / `*mainnet*`); the pid comes from
  `/proc/<pid>/exe` = `<dir>/grin`, matched back to the session via `_grin_session_name`. A
  session name carrying neither net writes nothing.
- **A stop path that signals grin itself writes the marker FIRST.** Scripts 01 (`stop_grin_*`),
  03 (`stop_grin_node`), 07 solo, 08del and 081's remote stop all SIGTERM by port before any
  `gnc_kill_*`, so they call `gnc_mark_planned_stop` / `gnc_mark_all_planned_stops` explicitly.
  `gnc_kill_grin_session`, `gnc_kill_all_grin_sessions` and `gnc_kill_grin_procs` also write it.
- **Never downgraded.** A `pid=0` write never replaces a marker that names a pid. Without this,
  a SIGTERM-first stop (pid named) followed by its own relaunch (the launcher's kill finds only
  the held pane, `pid=0`) would lose the pid before the recorder's next check, and a quick
  toolkit restart would count as an outage. A write with no `reason` for the same live pid,
  within 120 s, keeps the existing line (so `gnc_kill_grin_procs` does not blank the caller's
  reason).
- **A marker explains a stop only if `marker.pid` equals the pid the recorder last saw.** A marker
  with `pid=0`, or a different pid, explains nothing. This case arises when a crashed node's
  `read`-held pane is cleaned up by a later toolkit start: the session existed, the process was
  already dead, and the crash must stay a crash.
- **`by=grin-node-sync-watchdog` is never a planned stop.** It is a watchdog restart, which the
  `capture` hook already recorded (§8.9).
- **TTL** (`marker_ttl_min`, default 15). An unconsumed marker older than its TTL means the kill
  failed or never happened. It is deleted and logged once (`stale_marker`). The node's state is
  unaffected.
- **Consumption.** The transition that uses a marker (rule 6 or 7) deletes it. The marker lives in
  the recorder's own dir, so deleting it is not a write into the node dir.
- **A stop that bypassed the toolkit** (a raw `kill`, or Ctrl+C in the pane) has no marker, so it
  becomes `unexplained_stop`. The recorder never guesses that such a stop was planned.

### 8.6 Failure classes and the signatures they key on

Every class is a **lean, not a verdict** — the same rule as §3's likely origin. `summary.txt` and
every alert say "likely, not a verdict".

**Initial class** (Part 2: from the recorder's own inputs, no log reading):

| Observation | `class_initial` | `sub` |
|---|---|---|
| pid alive, API `timeout` ×2 | `hung` | `timeout` |
| pid alive, API `refused` ×2 after it had been `up` | `hung` | `port_closed` |
| pid alive, API `bad` ×2 | `hung` | `bad_reply` (PROVISIONAL) |
| pid gone, valid `last_exit` rc = 101, 134 (abort) or 139 (segv) | `crashed` | `rc=<n>` |
| pid gone, valid `last_exit` rc = 137 (SIGKILL) | `killed` | `rc=137` |
| pid gone, valid `last_exit` rc = 0, 130 or 143 (SIGINT/SIGTERM), no marker | `unexplained_stop` | `rc=<n>` |
| pid gone, any other non-zero rc | `crashed` | `rc=<n>` |
| pid gone, no valid `last_exit` | `unexplained_stop` | `exit_unknown` |
| no `ok` within `start_timeout_min`, or the process exited before its first `ok` | `failed_start` | `timeout` or `exited rc=<n>` |
| watchdog `capture` reason starting `wedged:` | `wedged` | the watchdog's reason |

`exit_unknown` is a sub-reason, not a new class. It covers nodes started before Part 1, and nodes
started by the `@reboot` line (§8.13 F-1). Evidence refinement (below) usually turns it into
`killed` or `crashed`.

**Refinement** (Part 3: evidence-based). The captured log window plus the pane are run through a
signature table. A match may refine `class_initial` → `class`. Both are recorded.

| Refines to | Signature (lower-cased ERE, mawk-safe) | Scope | Status |
|---|---|---|---|
| `corrupted` | `attempting to open (kernel\|output\|rangeproof) pmmr .*fail \(verify failed\)` | log lines from the last `starting server` up to the failure | **CONFIRMED** (2026-09-30 log, see the draft upstream issue) |
| `corrupted` | `mdb_corrupted\|mdb_page_notfound\|mdb_bad_txn\|mdb_invalid` | start window only | PROVISIONAL (LMDB's own error names; not yet seen on these boxes) |
| `corrupted` | `corrupt\|invalid ?root\|txhashset.*(invalid\|fail)` | **start window only** | PROVISIONAL. §4 records that a peer's bad block produces the same words during sync. Outside the start window these never mean `corrupted` |
| `killed` | kernel: `out of memory: killed process [0-9]+ \(grin\)\|oom-kill:.*task=grin` | `journalctl -k` since the last good check | CONFIRMED format (Linux kernel); unseen here |
| `crashed` | `panicked at` | log + pane | CONFIRMED by 086's table. **With a live pid it is `hung` + `sub=thread_panic`, not `crashed`.** A Rust panic off the main thread kills only that thread, and the process lives on (PROVISIONAL until we know whether grin builds with `panic=abort`) |
| `hung` + `sub=compaction` | `compact` within the window, on an archive node (`archive_mode=true`) | log window | PROVISIONAL. 5.5.1 logs compaction at debug only; the toolkit's patch `0002` adds info-level timings (memory `reference_grin_archive_compaction_storm`). It is **not suppressed**: a compaction hang is a real outage |
| `hung` + `sub=io_stall` | kernel `blocked for more than\|hung_task` naming grin | `journalctl -k` | PROVISIONAL |
| `unexplained_stop` + `sub=clean_shutdown` | `grin::tui::ui - shutdown in progress, please wait` followed by `grin_servers::grin::server - shutdown complete` | log tail + pane | **SEEN** in the 2026-10-03 fact-finding (one pair, mainnet log set on vps152623, probably from the June `.log.backup`). Which trigger writes it (Ctrl+C, `q`, SIGTERM) is still open: checklist B answers that |

- **Sharing 086's table.** The preferred design moves `DG_SIG_RE` / `DG_SIG_NAME` /
  `DG_SIG_ORIGIN` / `DG_SIG_HINT` into a small shared lib, with byte-identical arrays so that 086's
  output does not change. The recorder adds its own class-mapping table on top. 086's
  "chain-corrupt is WARN" rule and the recorder's "corrupted only in the start window" rule express
  the same caution.
- **`auth` is not a failure class.** It is the `auth_fail` state (§8.4).

### 8.7 On-disk layout

```
/opt/grin/node-events/                      0755 root   (the pool, as grinpool, must traverse it)
  .lock                                      0600       flock: check vs capture serialisation
  <net>/                                     0755
    status.json                              0644       rewritten every check (temp + mv)
    ledger.jsonl                             0644       append-only, one line per transition
    planned_stop                             0644       written by gnc_kill_grin_session (Part 1)
    evidence/                                0700 root
      <YYYYmmddTHHMMSSZ>_<class>/            0700       one bundle
/opt/grin/conf/node-events/recorder.conf     0600 root  KEY=VALUE, parsed not sourced
/usr/local/bin/grin-node-events              0750       generated worker (quoted heredoc)
/opt/grin/lib/{grin_node_control,grin_node_events,…}.sh  copies the worker sources (not the repo)
/etc/systemd/system/grin-node-events.{service,timer}
/etc/logrotate.d/grin-node-events            ledger.jsonl: size 10M, rotate 12, copytruncate off (rename + new file)
```

- **Not under `/opt/grin/logs/`.** Checked against the repo (checklist F): hub 08's automatic Disk
  Cleanup deletes **every** file in `/opt/grin/logs` older than N days, whatever its name
  (`find /opt/grin/logs -type f -mtime +N -delete`). The manual "Grin logs" action targets
  `$GRIN_LOG_PATH`, defaulting to `$HOME/.grin/main/log`. Neither touches `/opt/grin/node-events/`
  or a node dir's `grin-server.log`. The layout above is safe from both.
- `status.json` and `ledger.jsonl` are world-readable on purpose: they hold nothing sensitive. The
  `grinsecret` group is NOT reused; it means "may read node secrets".
- 089 backs up `/opt/grin/conf/` wholesale, so `recorder.conf` and its alert tokens ride along,
  exactly like 082's `alert.conf`. Whether to back up `ledger.jsonl` is Part 5's call (default: yes,
  ledger only, no evidence).
- **Ledger rotation is rename-based** (`create 0644 root root`, no `copytruncate`), so the pool's
  ingest (§20.3 of the 07 design) sees a new inode and resets its offset. `copytruncate` can lose
  lines appended mid-copy.

### 8.8 Schemas (`v:1`)

**`ledger.jsonl`.** One JSON object per line, ≤ 1024 bytes. Each line is written with a single
`printf >>`, so an append is atomic against a concurrent reader. Unknown keys must be ignored by
readers; missing keys mean null.

```json
{"v":1,"id":"mainnet-1759500000-0","net":"mainnet","ts":1759500000,
 "event":"down","state":"down","class":"corrupted","class_initial":"failed_start",
 "sub":"verify_failed","outage_id":"mainnet-1759499940-0","started_at":1759499940,
 "duration_s":null,"pid":12345,"prev_pid":12001,"rc":101,"by":null,
 "reason":"no get_status ok within 30 min of start","evidence":"20251003T140000Z_corrupted",
 "boot_id":"3f2a9c1e","grin_version":"5.5.1","clean_shutdown":null,"observed_gap_s":null}
```

| Key | Type | Rule |
|---|---|---|
| `id` | string | `<net>-<ts>-<seq>`, unique per file; `seq` disambiguates same-second lines. The pool stores it as `recorder_event_id UNIQUE` |
| `ts`, `started_at` | int | Epoch seconds UTC. Always < 2^53 |
| `event` | enum | `recorder_start` · `boot` · `start` · `stop` · `down` · `up` · `reclass` · `restart_by_watchdog` · `auth_fail` · `auth_ok` · `probe_error` · `gap` · `stale_marker` · `unregistered` |
| `state` | enum | §8.4 states |
| `class`, `class_initial` | enum \| null | §8.6 classes. `reclass` lines carry both |
| `sub` | string \| null | `[a-z0-9_=:.-]`, ≤ 40 chars |
| `outage_id` | string \| null | The `id` of the `down` line that opened it; set on `down`, `reclass`, `restart_by_watchdog` and the closing `up` |
| `duration_s` | int \| null | Set only on the `up` that closes an outage, and on the `boot` that closes one |
| `pid`, `prev_pid`, `rc` | int \| null | |
| `by` | string \| null | Marker `by`, `grin-node-sync-watchdog`, `boot_autostart` or `unknown`; `[A-Za-z0-9_.-]`, ≤ 40 |
| `reason` | string \| null | ≤ 160 chars, printable ASCII. Our own words or the watchdog's reason; **never log text** |
| `evidence` | string \| null | Bundle dir name only, never a path |
| `boot_id` | string | First 8 hex characters |
| `grin_version` | string \| null | e.g. `5.5.1` |
| `clean_shutdown` | bool \| null | `boot` lines only |
| `observed_gap_s` | int \| null | `gap` lines only |

**`status.json`.** Rewritten every check, atomically.

```json
{"v":1,"net":"mainnet","updated":1759500030,"recorder_version":"2026-10-03",
 "boot_id":"3f2a9c1e","state":"up","class":null,"sub":null,"since":1759490000,
 "up_since":1759490000,"node_started_at":1759489000,"pid":12345,"grin_version":"5.5.1",
 "node_dir":"/opt/grin/node/mainnet-prune","last_api":"ok","last_ok":1759500030,
 "last_check":1759500030,"strikes":0,"first_fail_ts":null,
 "open_outage":null,"pending_restart_by":null,"alerted_for":[]}
```

- `open_outage` = `{"id","started_at","class"}` or null.
- `pending_restart_by` is set by `capture` (§8.9). The next check that sees a new pid consumes it,
  so the `start` event says `by: grin-node-sync-watchdog`.
- `alerted_for` holds the debounce keys (§8.10), capped at the last 20.
- **Freshness:** a reader treats `status.json` as stale when `now − updated > 120 s`. The pool's
  `up_days` source order depends on that (07 design §20.4).

### 8.9 Evidence bundles and the watchdog hook

**When a bundle is captured:**

- on the `down` transition;
- on each `restart_by_watchdog`, at most 3 per outage;
- on a `reclass` to `corrupted`.

Captures are rate-limited to one per network per 5 minutes, except for `corrupted`.

**Contents** (`evidence/<UTC-ts>_<class>/`, root 0700, files 0600). Raw on the box, because only
root reads it. Masking (`dg_maskip` / `dg_redact`) happens at **export** (Part 5), never in place.

| File | Content | Cap |
|---|---|---|
| `summary.txt` | net, class, `class_initial`, sub, the matched signature line, timings, "likely, not a verdict" | — |
| `grin-log.txt` | the node log since the last good check, minus 2 min, across a rotation boundary (086's `dg_log_window` approach). The grin log stamps LOCAL time, so the window is converted with the box's TZ | 5000 lines |
| `pane.txt` | `capture-pane -p -J -S -300` from grin's socket (guarded, §8.2) | 300 lines |
| `exit.txt` | `.grin_last_exit`, `.grin_last_start` | — |
| `kernel.txt` | `journalctl -k --since @<last_ok−120>`, filtered for oom, I/O and fs errors and hung tasks | 500 lines |
| `host.txt` | `free -m`, `swapon --show`, `df -h` + `df -i` of the node dir, loadavg, `uptime`, PSI (`/proc/pressure/*`) | — |
| `ps.txt` | `ps -o pid,ppid,stat,lstart,etime,rss,args` for grin and its parent shell | — |
| `watchdog.txt` | the last 20 lines of `node-watchdog.log` | 20 lines |
| `chain.txt` | **`failed_start` / `corrupted` only:** `ls -l` and byte sizes of `chain_data/txhashset/{kernel,output,rangeproof}/`, `pmmr_hash.bin % 32` per MMR, and `tail -c 64 pmmr_data.bin \| xxd` for kernel | — |
| `manifest.txt` | file list and sizes; `truncated=yes` if any cap was hit | — |

**Caps:** 50 MB per bundle (`evidence_bundle_mb`), 500 MB in total (`evidence_total_mb`), 180 days
(`evidence_days`). Pruning runs after each capture and once a day. It deletes the oldest bundles
past the age limit first, then past the total cap. A bundle whose dir name a `corrupted` ledger line
references is pruned last.

**The watchdog hook** (Part 3) is the ONLY change to the watchdog. In the generated
`do_restart()`, after the cooldown check and before `gnc_start_node_tmux`:

```bash
[ -x /usr/local/bin/grin-node-events ] && timeout 20 /usr/local/bin/grin-node-events capture "$net" watchdog_restart "$reason" >/dev/null 2>&1 || true
```

- **It never blocks or fails the restart:** `timeout 20` plus `|| true`, and it is skipped when the
  recorder is absent.
- `capture` takes the shared lock with `flock -w 15`. If the lock is busy, it gives up rather than
  delaying the restart.
- It appends `restart_by_watchdog` (with the watchdog's reason; `wedged:` → class `wedged`) and sets
  `pending_restart_by`.
- Existing installs pick it up only when `gnk_watchdog_install` next regenerates the worker.

### 8.10 Alerts and debounce (Part 4)

Delivery code is **extracted** from 082 into a shared lib (`lib/grin_alert_send.sh`), not copied.
082's output must stay byte-for-byte the same. (As built, 082 inlines the lib into its generated
worker; see implementation §8.17.) The recorder has its own `recorder.conf`, with an
explicit "import channels from Access Watch" action. It never reads 082's `alert.conf` implicitly.

| Rule | Fires when | Priority | Debounce key |
|---|---|---|---|
| DOWN | an open outage reaches `alert_down_after_min` (default 3), measured from `started_at` | high | `down:<outage_id>` |
| CORRUPTED | a `down` or `reclass` with class `corrupted`, immediately | HIGH | `corrupted:<outage_id>` |
| RESTART LOOP | ≥ 3 `restart_by_watchdog` within 60 min | HIGH | `loop:<net>:<hour of the 3rd>` |
| RECOVERY | the `up` closing an outage that had a DOWN alert sent | default | `up:<outage_id>` |
| UNCLEAN HOST STOP | a `boot` with `clean_shutdown=false` while the previous state was `up` | default | `boot:<boot_id>` |

- **CORRUPTED text:** *"restarts will not fix this — chain_data needs a resync; evidence: <bundle
  dir>"*. The deferred "watchdog backs off on corrupted" is NOT part of this design (§8.14).
- **One outage sends one DOWN, one RECOVERY, and at most one CORRUPTED.** Each key is sent once
  and recorded in `status.json.alerted_for` before the next check. An outage shorter than
  `alert_down_after_min` sends nothing: no DOWN, and so no RECOVERY.
- **The body carries:** net, class, sub, duration and the one matched signature line. It carries no
  secrets, IPs, paths outside `/opt/grin/node-events`, or other log text.
- **Delivery is bounded, not backgrounded.** It uses `timeout 8` per channel and 20 s in total. The
  timer is `OnUnitActiveSec`, scheduled after the previous run *finishes*, so a slow send delays the
  next check by at most that overrun and two runs never overlap. A background child would be killed
  with the oneshot unit's cgroup anyway.
- `test-alert` sends one INFO message through every configured channel.

### 8.11 Worker, timer and configuration

- **Worker:** `/usr/local/bin/grin-node-events`.
  - Subcommands: `check` (the timer's run), `capture <net> <class> <reason>`, `show [net]`,
    `test-alert`.
  - Generated from a **quoted** heredoc (memory `reference_bash_unquoted_heredoc_backticks`), with
    mawk-safe awk.
  - It sources only `/opt/grin/lib/` copies, never the repo checkout.
- **Units:**
  - The timer has `OnBootSec=60s`, `OnUnitActiveSec=30s` and `AccuracySec=1s`.
  - The service is `Type=oneshot`, `Nice=10`, best-effort IO.
  - It is NOT `IOSchedulingClass=idle`. During the archive disk-thrash an idle-class recorder would
    starve, and that is exactly when it must run.
  - Cron's 1-minute floor is too coarse, which is why this is a timer.
- **Cost:** one `get_status` per net per 30 s (8 s cap, never parallel), plus a `/proc` scan. A
  typical check is under 2 s; the worst case is the 8 s timeout.
- **`recorder.conf` keys** (defaults):

  | Key | Default |
  |---|---|
  | `ENABLED_NETS` | `mainnet testnet`, intersected with the instances conf |
  | `DOWN_STRIKES` | `2` |
  | `START_TIMEOUT_MIN` | `30` |
  | `MARKER_TTL_MIN` | `15` |
  | `GAP_FACTOR` | `10` |
  | `EVIDENCE_BUNDLE_MB` | `50` |
  | `EVIDENCE_TOTAL_MB` | `500` |
  | `EVIDENCE_DAYS` | `180` |
  | `ALERT_DOWN_AFTER_MIN` | `3` |
  | `ALERT_LOOP_COUNT` | `3` |
  | `ALERT_LOOP_WINDOW_MIN` | `60` |
  | `ALERT_UNCLEAN_BOOT` | `1` |

  Plus 082's channel keys, under the same names. Every numeric value is validated against a range.
  An invalid value falls back to the default and logs once.

### 8.12 Operator UI and lifecycle (Part 5, summary)

- **086 sub-menu "Node event recorder":**
  - Install / Remove / Status.
  - **Timeline:** the last N events per net, coloured by class, with durations.
  - **Availability:** 7 / 30 / 90 d, with uptime % (excluding planned, boot and unobserved time),
    outages by class, MTBF and longest outage. Planned stops are listed separately.
  - **Show evidence.**
  - **Export for an upstream issue:** a masked tarball into `/opt/grin/logs/`. Hub 08's
    auto-cleanup will age it out after N days, so the screen says so.
  - **Alert settings.**
  - 086's support bundle gains the last 20 ledger lines plus `status.json`.
- **Script 01:** a default-YES install offer next to the watchdog, including in Super Auto.
- **08del:** removes the units, the worker and `/opt/grin/node-events/`. It asks before deleting
  evidence.
- Hub 08 has no free key, which is why the recorder lives inside 086.

### 8.13 Findings from the Part 0 reading (open — the operator decides)

**F-1 — the `@reboot` autostart bypasses the launch contract.**

- *What it does:* both `gnk_autostart_enable` (`grin_node_keepalive.sh` ~L107) and Script 03's
  autostart (~L2357) write `tmux new-session -d -s $sess '$binary server run'`. That line has no
  `; read` tail, no `env -u TMUX`, and nothing to capture the exit code.
- *Consequence:*
  - After every reboot, until the first toolkit or watchdog restart, a crash destroys the pane, and
    the panic text with it, the moment grin exits.
  - Part 1's `.grin_last_exit` will never be written for that run.
  - The plan's premise "the pane survives grin's exit until something kills the session" holds only
    for launcher-started sessions.
  - CLAUDE.md says every path that starts `grin server run` MUST go through
    `gnc_launch_node_session`.
- *Proposal (needs a decision before Part 1):*
  - Bring both `@reboot` lines into Part 1's scope.
  - The cleanest form calls a tiny installed entry point (e.g. `/usr/local/bin/grin-node-start
    <net>` → `gnc_start_node_tmux`), so the boot path IS the launcher.
  - The minimal form appends the same exit-capture + `read` tail to the existing line.
- *Until then:* the recorder handles such runs as `exit_unknown` (§8.6).
- **Decided + built (Part 1, 2026-10-03): the minimal form.** One builder,
  `_gnc_node_run_cmd <dir> <binary> [cron]` in `grin_node_control.sh`, emits the pane command
  (start stamp, `HOME=<dir> grin server run`, exit-code capture, `read`). The launcher (both
  branches), `gnk_autostart_enable` and Script 03 → G all use it; `cron` mode backslash-escapes
  `$` and `%` for the crontab line. The line stays self-contained, with no dependency on the
  toolkit checkout at boot. **An installed crontab changes only when autostart is re-enabled**
  (Script 03 → G, Script 01 Super Auto, or 07 solo's boot-autostart key). Until then, the old
  line's runs remain `exit_unknown`. 081's remote start snippet still launches without the
  tail (its nested quoting would need a rewrite); remote-started runs are `exit_unknown` too.
- *Confirmed live 2026-10-03 (vps152623):* both nodes there were started by the `@reboot` lines
  at the 2026-09-19 boot (mainnet `sleep 5`, testnet `sleep 1500`), and have run 14 days on panes
  that will not survive a crash. The testnet delay is 1500 s, not the default 1000. That confirms
  the recorder must READ the delay from the crontab line, never assume the default.

**F-6 — the node log holds only about 10 days of history.**

- *What it does:* `log_max_size = 16 MB` × `log_max_files = 3`. Most of each file is repeated noise:
  on vps152623, 10 days of mainnet log were mostly ~200k `failed to unban peer … PeerNotBanned`
  lines and ~100k lines each of `Failed to get coinbase` / `Can't connect to wallet listener`. The
  stratum server is enabled there with no wallet listening.
- *Consequence:* by the time anyone looks, the start and stop lines of a failure more than about
  10 days old have rotated away. On that box, checks A3/A4 found no `Starting server` line at all.
- *Resolution:* this confirms the design. Evidence must be copied out at the moment of failure
  (§8.9); later log reading cannot be relied on. Lowering the noise is a separate config decision
  and not the recorder's job.

**F-7 — restarting one node can kill the other network's node (live evidence, not yet reproduced).**

- *What it does:*
  - Both networks' nodes run on ONE tmux server: grin's socket.
  - That server is created by whichever launch comes first. It keeps that launch's cwd (the node
    dir) and argv (`tmux new-session … <dir>/grin server run`).
  - `gnc_kill_grin_procs <dir>` selects `pgrep -f 'grin server run'` hits whose cwd OR exe matches
    `<dir>`, so it selects that tmux server too.
- *Evidence:* on vps152623 (2026-10-03), pid 1041 is the tmux server (parent `/sbin/init`, cwd
  `mainnet-prune`), and it is the parent of BOTH the mainnet grin and the testnet grin (pid 6892).
- *Consequence:* any launcher restart of mainnet, from the watchdog or a toolkit menu, sends
  SIGTERM to pid 1041. That ends every session on grin's socket, so the testnet node dies, and
  nothing restarts it unless the testnet watchdog is enabled. A "the testnet node just died"
  report would look exactly like this. That is a hypothesis to keep in mind, not a confirmed cause.
- *Resolution:* Part 1 owns the launch contract, so it fixes this. `gnc_kill_grin_procs` must
  match on exe (`readlink -f /proc/<pid>/exe` = `<dir>/grin`, or `comm` = `grin`), never on
  cwd/cmdline alone. The recorder's pid lookup (§8.3) already requires exe. Fact-finding script B
  is restricted to testnet for this reason: a testnet stop matches only the testnet grin.
- **Fixed (Part 1, 2026-10-03), still unreproduced.** `gnc_grin_pids_for_dir` matches the exe only
  (`<dir>/grin`, or its `readlink -f`, with a ` (deleted)` suffix stripped), and
  `gnc_kill_grin_procs` uses it. Its full sweep (no dir) now also requires an exe named `grin`.
  The Part 1 audit found the same cwd match in two more places, both now exe-based. One is
  Script 01's `start_grin_tmux` orphan kill, which SIGKILLed any cwd hit, so it could hit the
  shared server. The other is 081's remote start snippet.

**F-2 — every start passes through the kill path.**

- *What it does:* `gnc_launch_node_session` calls `gnc_kill_grin_session` before starting.
- *Consequence:* a marker written unconditionally in the kill path would appear on every start,
  including the watchdog's restarts.
- *Resolution:* §8.5 resolves it with `pid=`, `by=` and "write only when something is there".
  Part 1 implements it, plus the never-downgrade rule (§8.5).

**F-3 — `gnc_owner_get_status` puts the owner secret in argv** (`curl -u grin:$secret`).

- The watchdog does this every 5 min today.
- The recorder must not repeat it every 30 s; it uses `-K -` (§8.2).
- Fixing the shared function is out of this plan's scope. It is a one-line change with many
  callers, so it is listed here as a deferred item.

**F-4 — the pool cannot tag an auth failure today.**

- *What it does:* `lib/grin-node.js` throws `HTTP 401` as `transport:'other'`, the same tag as a 5xx
  or an nginx error page.
- *Consequence:* `auth` cannot be classified without reading the message.
- *Resolution:* Part 6 adds the tag at the source (07 design §20.2).

**F-5 — the pool unit can already read the recorder's files.**

- *What it does:* `grin-pool-manager` runs `ProtectSystem=strict` + `ProtectHome=yes` +
  `PrivateTmp=yes`, with no `InaccessiblePaths` and no `ReadOnlyPaths`. `strict` leaves `/opt`
  readable.
- *Consequence:* Part 6 needs **no unit change**. The only requirement is the 0755/0644 modes in
  §8.7.
- *Remaining check:* checklist G confirms the live unit matches the template, because an older
  install may differ.

### 8.14 Out of scope (deferred)

- **Watchdog backs off on `corrupted`.** Today the watchdog restarts a corrupted node every 20 min
  forever. A change to the restarter, not the recorder, would fix that. It is a separate decision,
  for after VPS acceptance.
- **Fleet view.** 081 pulling `status.json` from every box.
- **F-3's shared-function fix.**

- **Converging Script 03's older `lib/grin_alerts.sh`** onto `lib/grin_alert_send.sh`
  (implementation §8.17).

### 8.15–8.22 As built → [`script086_implementation.md`](script086_implementation.md)

The as-built record moved out of this design on 2026-10-03 and kept its numbers, so a reference to
"086 §8.15" (in a code comment, say) means the implementation doc:

| § | Content |
|---|---|
| 8.15 | Part 2 as-built deltas: the recorder core |
| 8.16 | Part 3 as-built deltas: evidence, classification, the watchdog hook |
| 8.17 | Part 4 as-built deltas: off-box alerts, the 082 extraction |
| 8.18 | Part 5 as-built deltas: the key 7 sub-menu, Script 01, 08del, 089 |
| 8.19 | The R1 review of Parts 1–5: fixed and open findings |
| 8.20 | Launch-contract additions, and what reaches an installed box when |
| 8.21 | `gne_classify`'s rule order as built |
| 8.22 | Status, the VPS acceptance list, open items |

Where the build differs from §8.1–§8.14 above, the implementation doc wins.
