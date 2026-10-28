# Script 086 — Diagnostics & Support Bundle

> **Covers code as of:** 2026-09-25 for §1–7 · 2026-10-03 for §8.1–§8.14 and 2026-10-27 for §9 ·
> 2026-10-28 for §10 (written against `add-ons` at `cdbf2d2` and grin tag `v5.5.2`; built the same day, as-built record in the implementation doc §10) (§1–§9: DESIGN, written
> before the code against `grin_node_control.sh`, `grin_node_keepalive.sh`, `086_lib_diag.sh`
> and `082_provider_access_watch.sh` as committed at `65d5061`; §8.5 and §8.13 also carry the
> launch-contract decisions). The recorder and its post-build fixes are built, uncommitted and never run; where the
> build differs, the as-built record wins: it moved to
> [`script086_implementation.md`](script086_implementation.md) §8.15–§8.22 on 2026-10-03 ·
> **Last verified:** 2026-10-03, PARTIAL — §8 only, by the post-build review (implementation §8.19):
> §8.2's read-only gate by grep, §8.4/§8.5's transitions and §8.10's debounce by a local harness
> over the pure functions. Nothing installed or run on a VPS; §1–7 never systematically verified.
> §10: its toolkit file:line references were read against `cdbf2d2` and its grin references
> against the `v5.5.2` sources on 2026-10-28, when it was written, and re-read the same day by a
> separate design review against the same commit and tag, which corrected the wrong ones; nothing
> of §10 is built ·
> **Product code last changed:** 2026-10-27 — the §9 public status page (uncommitted): `scripts/lib/grin_node_public.sh`, `grin_node_public_compact.sh`, `grin_node_public_run.sh` (new), `grin_node_events.sh`, `scripts/086_grin_diagnostics.sh`, `089_backup_restore.sh`, `08del_clean_all_grin_things.sh`, `web/04_node_api/`, `web/06d_tiny_explorer/` (§9 was not checked against a run) ; 2026-10-03 — `scripts/086_grin_diagnostics.sh` (key 7: recorder
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
`scripts/lib/086_lib_recorder.sh` (key 7's read side of the §8 recorder),
`scripts/lib/grin_node_public*.sh` (the §9 public status page),
`scripts/lib/086_lib_stratum.sh` (key 8, §10 — designed, not built). The recorder's own
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
| 8 | Mining / stratum latency (§10, designed, not built) — black-box template-latency probe, build log, rejects per hour, per-thread CPU, stack capture, A/B compare | no node setting or restart. One probe connection to the node's stratum port; on a node with no other stratum client that makes it build templates, so it asks first (§10.2.4). Package install and debugger attach (a short pause of the node) only after a typed `y` |

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

## 8. Node event recorder — design (built and reviewed, never run; as-built → `script086_implementation.md` §8.15–§8.22)

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
| `last_start` | `<node_dir>/.grin_last_start` (`ts=<epoch>`) | Written by the node's tmux pane (`_gnc_node_run_cmd`): launcher starts AND `@reboot` lines written since the launch contract. Absent on nodes started before it, by an `@reboot` line not re-enabled since (§8.13 F-1), or by 081's remote start. |
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

### 8.5 Planned stops — the marker contract (the launcher writes, the recorder reads)

`/opt/grin/node-events/<net>/planned_stop` is one line, written atomically (temp + `mv`) BEFORE the kill:

```
ts=<epoch> by=<caller script basename> pid=<grin pid at write time, or 0> reason=<optional, ≤80 chars>
```

- **It is written only when there is something to stop.** That means a live grin pid for that net,
  or a session on either socket. `gnc_launch_node_session` itself calls `gnc_kill_grin_session` on
  every start (§8.13 F-2), so an unconditional write would leave a marker on every start of an
  already-stopped node.
- **It is written only once the recorder is installed** (`/opt/grin/node-events/` exists). The
  writer creates `<net>/` (0755) but never the root, so `gne_install` must create
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

**Initial class** (from the recorder's own inputs, no log reading):

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

`exit_unknown` is a sub-reason, not a new class. It covers nodes started before the launch contract, and nodes
started by the `@reboot` line (§8.13 F-1). Evidence refinement (below) usually turns it into
`killed` or `crashed`.

**Refinement** (evidence-based). The captured log window plus the pane are run through a
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
    planned_stop                             0644       written by gnc_kill_grin_session
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
  exactly like 082's `alert.conf`. Whether to back up `ledger.jsonl` is an operator-UI decision (default: yes,
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
root reads it. Masking (`dg_maskip` / `dg_redact`) happens at **export**, never in place.

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

**The watchdog hook** is the ONLY change to the watchdog. In the generated
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

### 8.10 Alerts and debounce

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

### 8.12 Operator UI and lifecycle (summary)

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

### 8.13 Findings from the pre-build reading (open — the operator decides)

**F-1 — the `@reboot` autostart bypasses the launch contract.**

- *What it does:* both `gnk_autostart_enable` (`grin_node_keepalive.sh` ~L107) and Script 03's
  autostart (~L2357) write `tmux new-session -d -s $sess '$binary server run'`. That line has no
  `; read` tail, no `env -u TMUX`, and nothing to capture the exit code.
- *Consequence:*
  - After every reboot, until the first toolkit or watchdog restart, a crash destroys the pane, and
    the panic text with it, the moment grin exits.
  - The launch contract's `.grin_last_exit` will never be written for that run.
  - The plan's premise "the pane survives grin's exit until something kills the session" holds only
    for launcher-started sessions.
  - CLAUDE.md says every path that starts `grin server run` MUST go through
    `gnc_launch_node_session`.
- *Proposal (needed a decision before the launch contract was built):*
  - Bring both `@reboot` lines into the launch contract's scope.
  - The cleanest form calls a tiny installed entry point (e.g. `/usr/local/bin/grin-node-start
    <net>` → `gnc_start_node_tmux`), so the boot path IS the launcher.
  - The minimal form appends the same exit-capture + `read` tail to the existing line.
- *Until then:* the recorder handles such runs as `exit_unknown` (§8.6).
- **Decided + built: the minimal form.** One builder,
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
- *Resolution:* the launch contract owns this, so it fixes it. `gnc_kill_grin_procs` must
  match on exe (`readlink -f /proc/<pid>/exe` = `<dir>/grin`, or `comm` = `grin`), never on
  cwd/cmdline alone. The recorder's pid lookup (§8.3) already requires exe. Fact-finding script B
  is restricted to testnet for this reason: a testnet stop matches only the testnet grin.
- **Fixed, still unreproduced.** `gnc_grin_pids_for_dir` matches the exe only
  (`<dir>/grin`, or its `readlink -f`, with a ` (deleted)` suffix stripped), and
  `gnc_kill_grin_procs` uses it. Its full sweep (no dir) now also requires an exe named `grin`.
  The launch-contract audit found the same cwd match in two more places, both now exe-based. One is
  Script 01's `start_grin_tmux` orphan kill, which SIGKILLed any cwd hit, so it could hit the
  shared server. The other is 081's remote start snippet.

**F-2 — every start passes through the kill path.**

- *What it does:* `gnc_launch_node_session` calls `gnc_kill_grin_session` before starting.
- *Consequence:* a marker written unconditionally in the kill path would appear on every start,
  including the watchdog's restarts.
- *Resolution:* §8.5 resolves it with `pid=`, `by=` and "write only when something is there".
  The launch contract implements it, plus the never-downgrade rule (§8.5).

**F-3 — `gnc_owner_get_status` puts the owner secret in argv** (`curl -u grin:$secret`).

- The watchdog does this every 5 min today.
- The recorder must not repeat it every 30 s; it uses `-K -` (§8.2).
- Fixing the shared function is out of this plan's scope. It is a one-line change with many
  callers, so it is listed here as a deferred item.

**F-4 — the pool cannot tag an auth failure today.**

- *What it does:* `lib/grin-node.js` throws `HTTP 401` as `transport:'other'`, the same tag as a 5xx
  or an nginx error page.
- *Consequence:* `auth` cannot be classified without reading the message.
- *Resolution:* the pool side adds the tag at the source (07 design §20.2).

**F-5 — the pool unit can already read the recorder's files.**

- *What it does:* `grin-pool-manager` runs `ProtectSystem=strict` + `ProtectHome=yes` +
  `PrivateTmp=yes`, with no `InaccessiblePaths` and no `ReadOnlyPaths`. `strict` leaves `/opt`
  readable.
- *Consequence:* the pool side needs **no unit change**. The only requirement is the 0755/0644 modes in
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
| 8.15 | The recorder core as built |
| 8.16 | Evidence capture, classification, the watchdog hook |
| 8.17 | Off-box alerts, the 082 extraction |
| 8.18 | Operator screens and lifecycle: the key 7 sub-menu, Script 01, 08del, 089 |
| 8.19 | The post-build review: fixed findings are in the Build notes, open ones under Open items |
| 8.20 | Launch-contract additions, and what reaches an installed box when |
| 8.21 | `gne_classify`'s rule order as built |
| 8.22 | Status, the VPS acceptance list, open items |

Where the build differs from §8.1–§8.14 above, the implementation doc wins.

---

## 9. Public status page

**Status:** designed and built, not VPS-tested. As-built → [`script086_implementation.md`](script086_implementation.md) §9.

### 9.1 Goal

Each node box can publish a small public page about its own node, derived from the recorder
(§8) and nothing else:

- the current state (`up` / `starting` / `down` / `unknown`) and "up N days";
- availability over 7 / 30 / 90 days;
- a history of closed outages: UTC date, duration, kind and the known error type;
- planned restarts, listed but never counted against availability;
- grin compaction durations, when the grin build logs them;
- a way to check the page: an append-only, hash-chained history and a "check it yourself" `curl`.

It is outward-facing, so it is **off by default and opt-in per net**. The same mechanism serves
mainnet and testnet. On the node-API box the page is the 04 status page; on the archive/explorer
box it is the Tiny Explorer (06d) `/availability` page.

### 9.2 What is published, and what never is

Only the allow-listed keys of §9.4 are ever written. Every item below is refused by a gate
(`gnp_assert_public`) before a file is written, and each has a test:

| Never published | Why |
|---|---|
| grin log text, pane text, evidence, the ledger `reason`, the watchdog's reason | holds peer IPs and onion addresses; `reason` is free text |
| the timestamps of an OPEN outage (`started_at`, `since`, `first_fail_ts`) | the health-API rule: "up N days" only, never a timestamp |
| exact times in history | a UTC **date** and a duration rounded to the **minute** |
| pid, boot id, node dir, grin version, evidence names, `by`, the rc of a planned stop | host fingerprinting with no value to a visitor |
| an open outage in the list | it appears only once closed |
| alert config, `recorder.conf` | secrets |

An error type is shown only if it is on the label allow-list (§9.5); anything else is printed
as the class's kind with no error. A grin log line never reaches a public file.

### 9.3 Design decisions and why

- **The chain covers a PUBLIC history file, not the ledger.** Visitors never see `ledger.jsonl`,
  so a chain over it could only be checked by root, who can rewrite the ledger and its chain
  together. A chain over the published records can be checked by anyone who kept an earlier copy:
  today's file must extend yesterday's byte for byte. The ledger and the pool's ingest are untouched.
- **Availability counts `auth_fail` as up.** `% = up / (observed - planned)`: the node answers,
  so it is available. Unobserved time and planned time are printed next to the percentage
  ("99.41 % · 29.6 of 30 d observed · 12 min planned"), never hidden. 086's own Availability row
  uses the same rule, so the screen and the page show one number.
- **One producer, two readers.** The recorder writes only its own `public/` dir and never a web
  root. 04's root `node-collector.py` copies the two files into its REST dir (it already does
  this for `node.json`, and nginx's existing `*.json` rule serves them). 06d's Express server
  reads the files directly, because the archive box may not run 04.
- **Error detail is the label only,** from an allow-list. A free-text error would leak log content.
- **Planned restarts** carry a date and a duration. The operator's marker `reason` is not published.
- **Backfill is honest.** The first enable starts the chain with a `chain_start` line, and outages
  already in the ledger are imported with `"imported":true`, so the chain says they were written
  after the fact. The same flag is set for any event that closed more than 2 h before it was
  appended, which covers a re-enable and an 089 ledger restore.
- **Compactions are listed only from `compact: finished` lines.** A grin build that logs nothing
  at Info makes the page say "Not logged by this grin build", rather than show an empty list as
  if nothing happened.
- **Disabling keeps the chain.** Taking a net out of `PUBLIC_NETS` removes only the two SERVED
  files. The chain (`history.jsonl`) and the salt stay, so a re-enable extends the same chain and
  a visitor's earlier copy still matches. A full wipe is 08del's job.
- **The `src` of a history line is salted.** An unsalted `sha256(outage_id)` plus the published
  date brute-forces back to the down line's exact second, which §9.2 forbids. A per-net secret
  salt fixes that. A missing salt beside an existing chain fails closed.
- **Publishing never delays the watchdog's capture.** It runs after the check has released the
  recorder's lock, under its own lock and time budget.

### 9.4 File contracts (`v:1`)

All files are in `/opt/grin/node-events/<net>/public/`. Only the first two are served.

**`availability.json`**, rewritten whole, one object. The only keys allowed:

```json
{"v":1,"net":"mainnet","generated":"2026-10-26T14:05Z","state":"up","up_days":12,
 "windows":{"7":{"pct":100.0,"observed_d":7.0,"planned_min":0,"outages":0},"30":{},"90":{}},
 "outages":[{"date":"2026-10-20","duration_min":95,"kind":"hung","error":"thread panic"}],
 "planned":[{"date":"2026-10-18","duration_min":6}],
 "compactions":{"logged":true,"last":[{"date":"2026-10-25","duration_s":41}],
                "d30":{"count":30,"median_s":38,"max_s":610}},
 "chain":{"lines":57,"head":"<sha256 hex of the last history line>"},
 "check":{"method":"get_tip"}}
```

(`"30"` and `"90"` carry the same four keys as `"7"`; shortened here.)

- `generated` has minute precision and is the render time, not an outage time.
- `state` is `unknown` when `status.json` is older than 120 s; `up_days` is null unless `up`.
  A page treats a record whose `generated` is more than 3 h old as `Unknown`, so a dead
  recorder cannot keep a stale "up" on show.
- `outages` and `planned` hold the newest 50 within 90 d; the full list is `history.json`.

**`history.jsonl`** (recorder side, append-only, never rotated, about one line per event):

```json
{"v":1,"seq":12,"type":"outage","date":"2026-10-20","duration_min":95,"kind":"hung","error":"thread panic","src":"<16 hex>","prev":"<sha256 of line 11>"}
```

- `type` is `chain_start`, `outage`, `planned` or `compaction`. Line 0 is `chain_start` with
  `"prev":null`. `prev` is the sha256 (hex) of the previous line's exact bytes, without the newline.
  `imported:true` is present on a line written after the fact. `date` is the event's UTC start date.
- `src` is an opaque dedupe key, always 16 hex = `sha256(salt || key)[0:16]`, where key is the
  ledger `outage_id` (a planned span: the id of the ledger line that opened it; a compaction:
  `c-<log-inode>-<offset>`). A re-run therefore never appends the same event twice.
- The salt is `/opt/grin/node-events/<net>/.public_salt` (64 hex, 0600, root, outside `public/`),
  created together with a new chain.

**`history.json`** is the served form: `{"v":1,"net":...,"lines":["<raw line>",...]}`. The raw lines
are carried as strings, so a visitor hashes exactly the bytes that were chained. It is `.json`
because 04's REST rule serves only `*.json`.

### 9.5 Public labels

The map lives in one place, `gnp_kind_label` / `gnp_error_label` in `scripts/lib/grin_node_public.sh`.
The web readers print `kind` and `error` as text (`textContent`), never as HTML.

| Recorder class → `kind` | | Recorder sub → `error` | |
|---|---|---|---|
| `hung` | hung | `thread_panic` | thread panic |
| `wedged` | sync stalled | `panic` | panic |
| `crashed` | crashed | `verify_failed:<mmr>` | PMMR verify failed (mmr is kernel, output or rangeproof only) |
| `killed` | killed | `oom`, `oom_start` | out of memory |
| `corrupted` | chain data corrupted | `lmdb` | LMDB error |
| `failed_start` | failed to start | `chain_error` | chain-state error |
| `unexplained_stop` | stopped (unexplained) | `io_stall` | disk I/O stall |
| `restart_by_watchdog` (with no down line) | restarted by watchdog | `compaction` | compaction |
| | | `timeout` / `port_closed` / `clean_shutdown` | API timeout / API port closed / clean shutdown |
| | | `rc=137` | SIGKILL; any other `rc=<n>` (1-3 digits, at most 255) gives `exit code <n>` |

An unknown class gives kind `unknown`; an unknown sub gives `error: null`.

### 9.6 Architecture: one producer, two readers

```
recorder worker (root, 30 s timer)                          readers
  check ──(unchanged)──► ledger.jsonl / status.json
  publish (after the check unlocks; every PUBLIC_EVERY_S      04 node-collector.py (root, 1 min)
           s, and at once when an outage closes)                public/{availability,history}.json
     ├─ history.jsonl     (hash-chained, append-only)            → <04 rest dir>/ → nginx /rest/*.json
     ├─ history.json      (served, atomic, 0644)                 → 04 status page "Availability"
     ├─ availability.json (served, atomic, 0644)
     └─ compaction scan   (reads grin-server.log, read-only)   06d tiny-explorer-server.js
                                                                  reads the same two files by name
                                                                  → /api/availability[/history], /availability
```

- `publish` takes its own lock (`public/.lock`), never the recorder's, and runs after the check
  has unlocked. A slow publish cannot delay the watchdog's capture.
- A visitor verifies by fetching `history.json`, hashing every raw line, and checking each
  `prev`; the last line's hash must equal `availability.json` `chain.head`:

  ```
  curl -s URL/history.json | jq -r '.lines[]' | { p=null; n=0; while IFS= read -r l; do
    q=$(printf '%s' "$l" | jq -r '.prev // "null"'); [ "$q" = "$p" ] || echo "BROKEN at line $n"
    p=$(printf '%s' "$l" | sha256sum | cut -c1-64); n=$((n+1)); done; echo "$n lines, head $p"; }
  short form: curl -s URL/history.json | jq -r '.lines[-1]' | head -c -1 | sha256sum   # = chain.head
  ```

  A chain proves that history was not edited behind a visitor's earlier copy. It cannot show an
  edit of the LAST line (nothing links to it yet), and it cannot show events that were never
  written. Only a reader who kept an earlier `chain.head` can detect a rewrite of the newest line.

### 9.7 Lifecycle

- **Enable / disable.** `PUBLIC_NETS` in `recorder.conf` (empty = off), set from 086 → recorder →
  `P`. Enabling states that the page becomes public and needs an explicit `y`. Disabling removes
  only the two served files and keeps the chain and salt (§9.3).
- **Backup (089).** `history.jsonl` and `<net>/.public_salt` are backed up as a pair: losing
  either breaks the chain or its dedupe. A restore puts the pair back only where the box has
  neither, and restores nothing from an incomplete pair.
- **Wipe (08del).** STEP 3c removes `public/` and `.public_salt` with the rest of the recorder
  state. Where the operator chooses the "move" path for evidence bundles, 08del first saves the
  chain and the salt beside the ledger, so the evidence and the ability to continue the chain
  both leave the box.
- **Remove (086 → recorder → `R`).** Takes the two served files down as well, so a removed
  recorder cannot leave a stale "up" on show; the chain and salt stay.
- **Traversal.** 06d runs as `www-data`; `/opt/grin` is created by the toolkit with whatever mode
  the umask gave. The publish adds `o+x` on `/opt/grin` only when the 06d unit file exists.
  04 needs nothing, its collector runs as root.

### 9.8 Verifying a box

On the box: `grin-node-events publish <net>` once, then `grin-node-events verify-chain <net>`
must print `OK: N lines, head <hex>`, and that head must equal `availability.json`
`chain.head`. Edit one byte in the middle of a copy of `history.jsonl` and verify must name
the line. Fetch the served URL from outside and run the recipe of §9.6 with real `jq`. On
testnet, `kill -9` of the node must produce, after recovery, one outage row with kind `killed`.
The acceptance list, with what is still owed, is implementation §9.8.

---

## 10. Mining / stratum latency (key 8)

**Status:** built 2026-10-28, uncommitted, never run on a VPS. The code is four libs,
`scripts/lib/086_lib_stratum.sh`, `_stack.sh`, `_baseline.sh` and `_screen.sh` (prefix `dgs_` / `dgss_`),
plus one menu arm in `scripts/086_grin_diagnostics.sh`.

**As built → [`script086_implementation.md`](script086_implementation.md) §10.** Where the build differs
from this section (the sub-menu and its `R` re-run, auto-save, the refusals, provenance, the compare
noise rule, the `steady` minimum), the implementation doc wins. The text below is the design as
reviewed.

Line references in this section are to the `add-ons` branch at `cdbf2d2` and to grin tag
`v5.5.2` (`mimblewimble/grin`). A grin reference describes v5.5.2 only. Whether a staging build
(grin PR #3939, say) has the same code path is **UNVERIFIED** until someone reads that diff.

| § | Content |
|---|---|
| 10.1 | What it answers, and why the pool badge and Solo Health cannot |
| 10.2 | The black-box probe: address, transport, wire messages, login, tip polling, run, output, loss, edge cases |
| 10.3 | The log view (only when DEBUG lines exist) |
| 10.4 | Node-side rejects per hour |
| 10.5 | Per-thread CPU |
| 10.6 | Stack capture |
| 10.7 | Baseline and A/B compare |
| 10.8 | Integration: quick check, bundle, signature row |
| 10.9 | Privacy, what it never does, open items |
| 10.10 | Screen mock |

### 10.1 What it answers

**Question:** how long does this node take to hand miners a job for a new tip, and where does that
time go?

Two screens already show the **symptom**. Neither can show the cause:

- **The pool's stale badge** counts shares the pool forwarded and the node answered with
  `Solution submitted too late` (the RPC message, `stratumserver.rs:103-107`). A high badge has
  several causes: slow templates, a slow miner link, a slow pool relay, or a burst of quick
  blocks. The badge cannot tell them apart.
- **Solo Health** ("Solo Health · Mainnet" in `web/07_mining_pool_solo/index.html:617-647`) turns
  the stale cell yellow at 3 % and red at 8 % (`metricCell(w.stale_pct || 0, 3, 8, …)`,
  `index.html:1615`). The counts come from the collector, which matches `too late` in the node
  log (`07_mining_block_collector.py:119`). It is the same symptom, counted from the node side.

Neither one times anything. The 2026-10-28 incident needed a hand diagnosis: 8.1–8.5 s from
`resend updated block` to `broadcast job` on every build, against under 0.2 s on v5.5.x. Key 8
makes that measurement one menu key. It works at the default Info logging, and it does not touch
the node.

**Why the delay costs hashrate (v5.5.2 mechanism):**

- The stratum loop polls `chain.head()` every 5 ms (`stratumserver.rs:532-536, 595`).
- When the head hash changes, the loop rebuilds. It also rebuilds when the refresh deadline
  passes. Either way it holds the `current_state` **write lock** for the whole build
  (`stratumserver.rs:541-588`).
- `handle_submit` takes the read lock (`stratumserver.rs:367`), and so does `getjobtemplate`
  (`:345`), so a share submitted during a build waits.
- After a new-block build, the height check fails, and the share is rejected as too late
  (`stratumserver.rs:369-380`).
- Miners keep hashing the old tip until the job arrives (`broadcast_job`,
  `stratumserver.rs:507-526`), so all of that time is dead work.

### 10.2 The black-box probe

The main measurement. It needs no log lines, so it works at any `file_log_level`.

#### 10.2.1 Which node, which address

1. **Node.** Key 8 picks the node the way every other 086 key does: `_pick_node`
   (`086_grin_diagnostics.sh:234-250`) over `DG_NODES` (`dg_discover_nodes`,
   `086_lib_diag.sh:98-115`), which gives the running pid, its dir, its net and its API
   `host:port` from `api_http_addr`. A net with no running node is never offered, so key 8
   never measures a node from a hard-coded dir (§4).
   - The pid is then cross-checked with the exe-only match: `gnc_grin_pids_for_dir <dir>`
     (`scripts/lib/grin_node_control.sh:222-235`) must return exactly that one pid. Otherwise
     key 8 prints both lists and stops.
   - That function matches the **grin exe** (`_gnc_exe_path`, `:206-212`), never cwd or argv.
     The incident showed why: `pgrep -f 'grin.*server'` matched the tmux bash wrapper first,
     then the testnet node. Each node dir holds its own copy of the binary (`install -m 755`,
     `01_lib_source_build.sh:907`), never a shared symlink, so the exe match cannot select
     the other network's node. If a dir's `grin` were ever a symlink to a shared file, its
     realpath branch would return both nodes' pids, and the exactly-one rule stops the run.
   - Everything below (toml, secret, log, `/proc/<pid>`) is read from that one dir and pid.
     Nothing is re-resolved by net name, because `grin_live_node_dir <net>`
     (`grin_node_secrets.sh:65-85`) follows tmux session names and conf vars and can name a
     different dir from the running process after a prune↔archive rebuild.
2. **Stratum switch.** Read `enable_stratum_server` from `<dir>/grin-server.toml` with `dg_tv`
   (`086_lib_diag.sh:78-81`).
   - Absent or `false` means **stratum disabled**: grin starts the stratum server only when the
     key is `Some(true)` (`servers/src/grin/server.rs:92-105`).
   - Key 8 prints the toml line the operator would change and stops (mock C in §10.10).
3. **Address.** Read `stratum_server_addr` the same way.
   - **Absent key with stratum on:** grin does not fall back to a default. The field is an
     `Option` with no serde default, so it reads as `None` and the stratum thread panics on
     `.unwrap()` at start (`stratumserver.rs:868-873`); nothing listens. Key 8 reports the
     missing key and points at the log's `panicked at` line. `127.0.0.1:3416`
     (`types.rs:271`) and testnet's `127.0.0.1:13416` (`config/src/config.rs:169-181`) are only
     what `grin server config` writes into a new toml.
   - `0.0.0.0` and `[::]` are dialled as `127.0.0.1`.
   - Key 8 dials only a loopback or local address. It never dials a remote host.
   - A port equal to the **other** network's toolkit port (3416 on a testnet node, 13416 on a
     mainnet one) is printed as a WARN before the run. The height check in §10.2.8 then proves
     which node answered.
   - The pool's stratum sync patches this address to `127.0.0.1:<node_stratum_port>`
     (`grin_node_secrets.sh:576-600`). Key 8 only reads it.
4. **Is it listening?** Check `ss -tln` for the port. If it is enabled in the toml but not
   listening, either the node has not restarted since the toml changed, or the bind failed.
   grin panics on a failed bind (`stratumserver.rs:605-607`), so key 8 points at the log.
5. **Refresh period.** Read `attempt_time_per_block` (default 15, `types.rs:268`). It is used in
   §10.2.6.
6. **Owner secret.** Resolve it with `dg_secret_path <dir> api_secret_path .api_secret <net>`
   (`086_lib_diag.sh:120-136`), the resolver 086's quick check already uses (`:448`). It reads
   the picked dir's toml and tries `~` as the node dir first, which is what the launch contract
   makes the running node expand it to. `grin_node_secret_path <net> owner`
   (`grin_node_secrets.sh:90-103`) is not used, because it resolves the dir by net name
   (item 1).
7. **Wallet listener.** Read `wallet_listener_url` and `burn_reward` (§10.2.4 needs them).

#### 10.2.2 Transport: `python3 -I`, not bash `/dev/tcp`

The probe is one `python3 -I` helper. The script travels as a quoted heredoc variable, and argv
carries no secret. Why python:

- **Its timestamps must not depend on the API.** One loop must wait on the socket and poll the
  tip at the same time. A bash loop (`read -t 0.2 -u 3`, then `dg_rpc`) cannot read the socket
  while curl runs, so every job line would be stamped late by the length of the last
  `get_status`. That error is largest exactly when the node is busy. Python waits on the socket
  with `select()` and runs curl as a child it does not block on, so a job line is stamped when
  the socket becomes readable.
- **Job lines are JSON.** Parsing `height` and `job_id` with grep breaks when field order changes,
  and serde gives no ordering promise.
- **python3 is already a dependency.** 086 has soft dependencies on it: `dg_body_field`
  (`086_lib_diag.sh:161-180`), `dg_peer_versions` (`:533-550`), and `gnc_status_field`
  (`grin_node_control.sh:720-740`). 086 records whether it is installed (`086_lib_diag.sh:395`).
  The solo collector is itself a python3 program (`07_mining_block_collector.py:1`). 086's
  existing bash `/dev/tcp` use (`086_lib_diag.sh:712`) is a fire-and-forget half request, with
  nothing timed.
- **Without python3,** the probe is unavailable, and so is everything else that reads or writes
  JSON or SQLite: the baseline file and the compare screen (§10.7), the quick-check finding
  (§10.8, which then shows INFO "python3 missing — template latency not checked"), and the
  optional solo section. Key 8 says so (mock F) and still runs §10.3–§10.5, which are bash and
  awk. It does not install python3.

Clock: `time.time()` for timestamps in the report, `time.monotonic()` for every interval.

**Lifecycle and timeouts** (the helper is the only long-running part of key 8):

- Every wait has a bound: TCP connect 3 s; the `login` reply 5 s; `select()` ticks at most every
  100 ms; each curl poll `--max-time 2`; a new tip with no matching job after 120 s closes that
  row as `no-job` (§10.2.8); the whole run stops at the cap of §10.2.6.
- A line from the node longer than 64 KiB, or a line that is not JSON, ends the run with that
  error. A job line is under 1 KiB.
- **Cleanup on every exit path.** The helper handles SIGINT and SIGTERM itself: it closes the
  socket, kills an in-flight curl child, and writes the rows it has as a partial result. Its
  `finally` does the same on an exception. The bash side sets `trap ':' INT` for the helper's
  run and puts 086's `trap 'exit 130' INT TERM` (`086_grin_diagnostics.sh:98`) back right after,
  on success and on failure.
- The helper's script, its result file and its stderr live in `$DG_TMP`, which 086's EXIT trap
  already removes (`:89-97`). bash reads the result file after the helper exits. No pipe sits
  between them.
- The screen copy goes to the `.txt` report through `> >(tee …)`, never `| tee`, for the reason
  §4 gives: a pipeline runs the function in a subshell, where its traps and variables are lost.
- Library functions run with errexit off, since every menu arm is `fn || true` (repo
  convention). Each create, write, chmod and delete in `086_lib_stratum.sh` carries its own
  `|| { error …; return 1; }`.

#### 10.2.3 Wire messages

The probe uses newline-framed JSON-RPC over TCP. Grin's server reads lines (`LinesCodec`,
`stratumserver.rs:628-641`). Shapes are from `stratumserver.rs` v5.5.2, and they match the pool's
client (`web/07_mining_pool_public/back-end-pool/lib/node-stratum-client.js:125-153`).

| Direction | Message | Source |
|---|---|---|
| → | `{"id":1,"jsonrpc":"2.0","method":"login","params":{"login":"<name>","pass":"","agent":"<agent>"}}`. All three params are required strings (`LoginParams`, `:146-151`). A missing field fails `parse_params` with `-32600 Invalid Request` (`:909-916`, `:121-126`) | `:283-287` |
| ← | `{"id":1,"jsonrpc":"2.0","method":"login","result":"ok","error":null}` | `:69-76`, `:286`, `:264-281` |
| → | `{"id":2,"jsonrpc":"2.0","method":"getjobtemplate","params":null}`. Sent once after login, so the probe learns the current height without waiting for the next broadcast | `:250-256` |
| ← | `result: {"height":H,"job_id":J,"difficulty":D,"pre_pow":"<hex>"}`, or `error: {"code":-32000,"message":"Node is syncing - Please wait"}` | `:162-167`, `:91-95`, `:316-327` |
| ← | push: `{"id":"Stratum","jsonrpc":"2.0","method":"job","params":{"height":H,"job_id":J,"difficulty":D,"pre_pow":"<hex>"}}` | `:507-526` |
| → | `{"id":N,"jsonrpc":"2.0","method":"keepalive","params":null}`, every 60 s, only to notice a dead link. Grin does not require it | `:290-292` |
| ← | `{"id":N,…,"method":"keepalive","result":"ok","error":null}` | `:290-292` |

**Two facts about the job push that the measurement relies on:**

- **`height` is the height being mined, which is the tip height + 1.** `build_block` reads
  `head = chain.head_header()` and builds at `head.height + 1` (`mine_block.rs:125, 156`). A job
  "for tip T" has `height == T + 1`.
- **`job_id` is the index of this build at the current height.** It is
  `current_block_versions.len() - 1` (`stratumserver.rs:348`), and the version list is cleared
  when the head hash changes (`:553, 577-579`). So **`job_id == 0` marks a new-block build**, and
  `job_id > 0` marks a deadline refresh of the same tip. The probe uses this to tell the two
  triggers apart without any log.

The probe **never sends `submit`** and never sends `status`. It reads `height` and `job_id` and
keeps nothing else from a job. `pre_pow` is parsed but neither stored nor printed.

#### 10.2.4 Login name

- **login** `toolkit-086-latency-probe`. The name has no dot, so the solo payout grouping
  (`_nick_of` splits at the first dot, `07_mining_block_collector.py:1029-1033`) could not fold
  it into a miner even if it ever reached a share line.
- **agent** `grin-node-toolkit-086/<toolkit version>`.

**The solo collector will not count it as a worker:**

- The collector creates a worker only from an accepted-share line:
  `Got share at height … submitted by <WORKER>` (`SHARE_RE`, `07_mining_block_collector.py:95`).
  Grin writes that line only after a valid submit (`stratumserver.rs:482-494`). The probe never
  submits, so its login never appears.
- `Worker N connected` / `disconnected` lines (`stratumserver.rs:626, 662`) carry no login, and
  the collector does not read them.

**The public pool cannot see it at all.** The pool is itself one stratum client of the node
(`node-stratum-client.js:125-130` logs in as the pool address). The probe opens a second, separate
connection to the node. The node never tells one client about another; its only fan-out is the
job broadcast (`stratumserver.rs:790-794`). The pool lists only the miners on its own stratum
ports, and no pool code counts sockets on the node's port. So the probe never appears in the pool
admin, and the pool's stale badge is unaffected.

**Side effects, all shown on screen before the run:**

- **`miners_connected` goes up by one.** The collector's `health.json` counts ESTABLISHED sockets
  on the stratum port (`proc_tcp_port_stats`, `07_mining_block_collector.py:763-788, 807`). A
  collector run during the probe reports one extra connection. That count does not gate `ok`
  (`:796-799`).
- **A node with no other connection starts building templates.** The loop builds only while
  `workers.count() > 0` (`stratumserver.rs:541-542`), and `count()` includes unauthenticated
  connections (`:796-798`). With nothing else connected, the probe's own connection starts
  builds: one every `attempt_time_per_block` and one per block, until it disconnects. Each build
  calls the wallet listener's `build_coinbase` (`mine_block.rs:227-249`).
  - The coinbase key is reused across rebuilds until a block is found (`stratumserver.rs:185,
    567`, reset only at `:243-245`), so the wallet derives at most one key.
  - **The wallet-listener trap.** If the listener does not answer, `get_block` never returns: it
    logs `Error building new block: Can't connect to wallet listener … will retry` and sleeps
    5 s, forever, while the stratum thread holds the state write lock (`mine_block.rs:70-110`).
    This does not stop when the probe disconnects. It stops only when the wallet answers. On a
    node with no miners and no wallet running, the probe would start an ERROR line every 5 s
    that outlives it.
- **The gate.** Before connecting, key 8 counts ESTABLISHED sockets whose **local** port is the
  stratum port (`ss -Htn state established '( sport = :<port> )'`), so the pool's own end of a
  same-host link is not counted twice.
  - One or more: the probe runs as one more client, and the screen says how many were there.
  - None, and `burn_reward = false`: key 8 first opens a TCP connection to the
    `wallet_listener_url` host and port, loopback only. If nothing listens there, it **refuses**
    and says why (mock E). If something listens, it shows mock E's warning and asks `[y/N]`,
    default No. A TCP accept does not prove `build_coinbase` works, and the warning says so.
  - A listener that is not on loopback is not dialled; key 8 says it could not check it and
    asks the same `[y/N]`. With `burn_reward = true` no wallet is called, and only the build
    warning is shown.

#### 10.2.5 Tip polling

- **Call.** Owner `get_status` on the picked node's API (`DG_NODES` host:port). The repo rule
  prefers it over `get_tip` (`.claude/context/grin_node_api.md`). It returns `tip.height`, `tip.last_block_pushed` and
  `sync_status` (grin `api/src/types.rs:46-55, 70-86`).
- **How the secret travels.** The python helper gets the secret file's **path** in argv, never
  the value. It runs `curl -s -K - --max-time 2 …` per poll and writes `user = "grin:<secret>"`
  to curl's stdin, with `\` and `"` escaped, the same pattern as `dg_rpc`
  (`086_lib_diag.sh:142-150`). The secret is read once at start and held in memory only.
  - `gnc_owner_get_status` is not reused, because it passes `-u grin:$secret` on argv
    (`grin_node_control.sh:699-711`).
  - Reachability needs a parsed `{"Ok":…}`, as everywhere in 086.
- **Interval.** 200 ms by default, settable from 100 to 1000 ms. One poll is in flight at a time.
  A poll still running when the next is due is skipped, not queued. Skipped polls and the p95
  poll latency are reported.
- **What counts as a new tip.** A change of `last_block_pushed`, not of height. A reorg to the
  same height changes the hash, and the stratum loop keys on the hash too (`current_hash !=
  latest_hash`, `stratumserver.rs:541`).

#### 10.2.6 Run, measurements, output

- **Length.** Stop at whichever comes first: 5 new-block jobs or 10 minutes. The operator may
  choose 3, 5 or 10 blocks. The hard cap is 30 minutes.
  - **Ctrl+C ends the run and keeps the partial result.** The probe sets its own INT trap
    around the helper, because 086's global `trap 'exit 130' INT TERM` (`086_grin_diagnostics.sh:98`)
    would otherwise leave the whole script.
- **Warm-up.** Nothing before the first tip change after connecting is measured.
  - `getjobtemplate` answers from the last build. On a node that had no clients, that build is
    old, or it is `Block::default()` at height 0 if no build ever ran (`stratumserver.rs:190-199`,
    `:328-352`). Its height is used only when it equals tip + 1.
  - On a node with no other client, the probe's connection triggers an immediate build with
    `job_id == 0` at the current tip. That job is a warm-up, not a new-block measurement.
- **Per new tip** (one row in the per-block list). Two timestamps bracket the head change:
  - `t_prev`: the **send** time of the last poll that still returned the old hash;
  - `tip_seen`: the **receive** time of the first poll that returned the new hash;
  - `job_at`: arrival of the first job with `job_id == 0` and `height == tip.height + 1`. It may
    arrive **before** `tip_seen`. On a healthy node that is common, because a build under 0.2 s
    beats a 200 ms poll. So the pairing is symmetric: a `job_id == 0` job whose height is above
    the last polled tip + 1 opens the row, and the poll that confirms the tip closes it.
  - **latency** lies in `[job_at − tip_seen, job_at − t_prev]`. The reported value is the lower
    end, `job_at − tip_seen`, and the screen prints the width of the bracket (`tip_seen − t_prev`,
    about P + r) as "true value up to +w" (§10.2.8, polling bias). A lower end at or below 0
    means the job beat the poll; that row reads "< w, below the probe's resolution".
  - flags: `reorg`, `queued`, `stale-on-arrival`, `superseded`, `no-job` (§10.2.8).
- **Refresh interval.** The gap between consecutive jobs at the same tip (`job_id` going
  1, 2, …).
  - The deadline is set after a build finishes, as whole seconds plus `attempt_time_per_block`
    (`stratumserver.rs:574`), and is compared in whole seconds (`:541`). The next build therefore
    starts between `attempt_time_per_block − 1` and `attempt_time_per_block` seconds after the
    last one ended. So a **deadline** rebuild took between
    `refresh interval − attempt_time_per_block` and 1 s more than that.
  - This is a second, independent estimate of build time. It needs no tip change.
- **Output.**
  - p50, p95 and max of the new-block latency, with n;
  - p50 of the refresh interval, with the derived deadline-build estimate;
  - the per-block list;
  - the loss estimate (§10.2.7);
  - the binary fingerprint (§10.7).
  - With fewer than 3 blocks, percentiles are not printed. The screen says "n too small" and
    lists the rows.

#### 10.2.7 Loss estimate

`loss ≈ mean new-block latency / mean block interval`

The block interval is the mean gap between the header timestamps of the last 60 blocks, with
60 s as the fallback. 8 s / 60 s ≈ 13 %, which is the operator's own figure.

It is an estimate. The caveats, all printed:

- It assumes all hashing on the old tip during the latency is lost. On v5.5.2 that holds for
  shares and for full solutions alike. Any submit at the old height after the tip change fails
  the height check (`stratumserver.rs:369-380`).
- It covers the **node** part only. The miner's link, the miner's reload time and, for the pool,
  the pool's relay all come on top and are not measured.
- Deadline refreshes cost nothing directly. Their job ids stay valid while the version list is
  kept (`:369-370`). But a tip that lands during a refresh build waits for it, because the loop
  is single-threaded (`:532-595`). Those rows are flagged `queued`. They are counted in the mean,
  because miners pay for them.
- A few blocks is a small sample. The screen prints n, and percentiles need n ≥ 3.
- The stale-share rate need not equal the loss. Stale counts only the shares found during the
  latency **and submitted**. The loss is the time itself, so the two can differ. The incident
  had a 6.6 % badge against a 13 % estimate (see §10.9 open items).

#### 10.2.8 Edge cases

- **Reorg.** A hash change at the same or a lower height is a new tip. Pairing uses the next
  `job_id == 0` job with `height == tip.height + 1`. The row is flagged `reorg` and kept.
- **Two quick blocks.** Tip T is seen, then T+1 before any job for T arrives.
  - The job for T can still arrive, because the build read the head when it started
    (`mine_block.rs:125`). It is then `stale-on-arrival`: its latency is real and counted, and
    those rows are counted separately as direct dead-work evidence.
  - If no job for T ever arrives, T is `superseded` and left out of the percentiles.
- **Queued behind a refresh.** If a job at the **old** height arrives after `tip_seen`, the loop
  was mid-refresh when the tip changed. The row is flagged `queued`.
- **No job.** A new tip with no matching job after 120 s closes as `no-job`, left out of the
  percentiles and printed in red. The usual cause is the wallet-listener trap of §10.2.4, so the
  screen names the log line to look for (`Can't connect to wallet listener`) and the listener
  address. Two `no-job` rows in a row end the run.
- **Wrong node on the port.** After warm-up, every `job_id == 0` job must sit at the polled
  tip + 1 within one block. Heights that never line up mean the stratum port belongs to a
  different node than the API that is polled, such as the other network's node on a mis-set
  port. The run stops with that message and measures nothing.
- **Syncing node.** If `sync_status` is not `no_sync`, or `getjobtemplate` returns `-32000`
  (`stratumserver.rs:250-255`), the probe does not start. grin waits for the **first** sync to
  end before its build loop starts (`:898-901`). It does not stop building during a later
  sync, so the probe's own rule applies: if `sync_status` leaves `no_sync` mid-run, the run
  stops and keeps the rows it has.
- **Node not answering.** The pid is known (§10.2.1), so this is a running node that does not
  answer: `get_status` times out or fails, and the stratum connect is refused or gets no
  `login` reply. Key 8 prints mock D in §10.10. Nothing is retried in a loop. A pruned 5.5.x
  node can freeze for about 100 s while it compacts, so the screen suggests waiting two minutes
  before running it again.
- **Poll timeouts mid-run.** A poll that times out is counted. A row whose bracket
  (`tip_seen − t_prev`) is wider than 2 s is flagged `wide` and left out of the percentiles,
  because its start time is unknown to within that width.
- **Polling bias.** The head changed somewhere between `t_prev` and `tip_seen`, a window of
  about P (the poll interval) plus the poll's own latency r.
  - So the true latency lies in `[measured, measured + w]`, with w = `tip_seen − t_prev` per
    row. The screen prints the p95 of w once, under the percentiles.
  - A healthy v5.5.x build (under 0.2 s) is close to P. A measured value below w is shown as
    "< w, below the probe's resolution", never as a number that looks precise. Such rows count
    as 0 in the percentiles, and the run never WARNs on them.
  - The stratum loop itself polls every 5 ms (`stratumserver.rs:595`), so its own lag is
    negligible.

### 10.3 Log view (only when DEBUG lines exist)

A second view. It explains **where** in the build the time goes, but it exists only when the node
logs at Debug.

**Lines** (all `debug!` in v5.5.2):

| Line | Source | Marks |
|---|---|---|
| `resend updated block` | `stratumserver.rs:545` | build start, write lock taken |
| `get_coinbase: …` | `mine_block.rs:246` | wallet `build_coinbase` returned |
| `Built new block with …` | `mine_block.rs:177-183` | block assembled and validated. Next is `set_txhashset_roots` (`:186`) |
| `broadcast job` | `stratumserver.rs:508` | lock released (the write-lock block ends at `:588`); the template is serialised next |
| `(Server ID: 0) sending block H with id J to stratum clients` | `stratumserver.rs:521-524` | gives the height and job id; the job goes to the workers next (`:525`) |

**Pairing.**

- Each `resend updated block` pairs with the next `broadcast job`. Lines in between are segment
  marks. A resend with no broadcast before the next resend is reported as an incomplete build.
- **Trigger** comes from the `sending block … with id J` line: `J == 0` is a new block,
  `J > 0` is a deadline refresh. Nothing is inferred from timing.
- **Segments** printed per build:
  - A = resend → `get_coinbase` (difficulty, txpool, wallet call);
  - B = `get_coinbase` → `Built new block` (block assembly and `validate`);
  - C = `Built new block` → `broadcast job` (`set_txhashset_roots` plus the state update);
  - D = `broadcast job` → `sending block` (template serialisation, expected to be tiny).
  - In the incident's example, A+B was 135 ms and C was 7.38 s (10.005 → 10.140 → 17.524).
    The segments show **which call** is slow. They do not show **why**; that needs §10.6.
- **Output.** p50, p95 and max of the total and of each segment, split by trigger, over the
  chosen window (1 h, 6 h or 24 h, read with `dg_log_window` / `dg_log_filter`,
  `086_lib_diag.sh:206-220`). Then the 10 slowest builds with their timestamps.
- **Timestamps.** Grin's log prefix is local time with milliseconds (`YYYYMMDD HH:MM:SS.mmm`, the
  form `dg_triage` already matches at `086_lib_diag.sh:228`). Intervals are differences of two
  prefixes, so the box's timezone cancels out, with two exceptions the parser handles:
  - **Midnight.** Seconds are computed from `substr()` fields; when the date part of a pair
    differs, 86 400 s is added. mawk has no `mktime`, so no date function is used.
  - **A DST change** inside a pair shifts it by an hour. A pair longer than 600 s is reported
    as incomplete, never as a build time.

**Detecting Info logging.**

- Read `file_log_level` from the toml. grin's levels are `Error, Warning, Info, Debug, Trace`
  (`config/src/comments.rs:466-468`).
- Also count `resend updated block` lines in the window. Zero lines with stratum enabled means
  "not logged", whatever the toml says, because the toml may have changed since the node
  started.
- The screen then says:

  > Build lines are DEBUG; this node logs at Info. To see them, set `file_log_level = "Debug"`
  > under `[logging]` in `<dir>/grin-server.toml` and restart the node through the toolkit.
  > Debug writes several times more log. Set it back afterwards. 086 does not change it.

Key 8 never edits the toml and never restarts the node (§10.9).

### 10.4 Node-side rejects per hour

All reject lines are `error!` in v5.5.2, so they are logged at every `file_log_level`, Error
included:

| Kind | Log text (tolower) | Source |
|---|---|---|
| stale | `share at height H, edge_bits E, nonce N, job_id J submitted too late` | `stratumserver.rs:374-376` |
| low difficulty | `… rejected due to low difficulty: a/b` | `:411-413` |
| invalid | `failed to validate solution …` (cuckoo size, or `process_block` error) | `:394-397`, `:426-435` |
| invalid share | `failed to validate share …` | `:459-467` |

- **The node log does not contain the words "Solution submitted too late".** That string is the
  RPC error sent back to the miner (`:103-107`). The log line ends `submitted too late`. Matching
  `submitted too late` catches both, so a pool or miner log reads the same. The same holds for
  `rejected due to low difficulty` and `failed to validate solution` (RPC messages at `:109-119`).
- **Accepted shares** (`Got share at height`, `info!`, `:482-494`) give the denominator. They are
  logged when `file_log_level` is Info, Debug or Trace, not at Warning or Error.
  **Stale %** = stale / (accepted + stale + all invalid) is printed only when accepted lines
  exist. Otherwise the screen shows counts alone and says why.
- **Per hour.** A table of counts per kind for each hour of the window, like `dg_log_hourly`
  (`086_lib_diag.sh:288-308`).
- **Burst vs steady**, from per-minute buckets of the stale lines:
  - **burst**: at least 10 stale lines in the window, and one 10-minute span holds half or more
    of them. Typical of quick blocks or a reorg.
  - **steady**: at least 10 stale lines in the window, in at least 75 % of its hours, with no burst. This is the
    signature of slow templates: the incident's 117 in 6 h, spread evenly.
  - **scattered**: neither, including any window with fewer than 10 stale lines.
  - The label is a lean, like every 086 origin.
- **With Debug on,** stale lines are also matched to the preceding `job_id == 0` broadcast. The
  screen shows the share of stale lines that landed during a new-block build.

### 10.5 Per-thread CPU

- **PID.** From the node dir with the exe-only match (`gnc_grin_pids_for_dir`, §10.2.1). Exactly
  one pid is required. With two or more, key 8 prints them and stops (the duplicate-node finding,
  `086_lib_diag.sh:426-428`).
- **Sample.** Read `/proc/<pid>/task/*/comm` and `/proc/<pid>/task/*/stat` twice, 10 s apart.
  CPU = Δ(utime + stime) / CLK_TCK / 10 s.
  - Fields are taken after stripping `pid (comm) `, as `dg_sample_procs` does
    (`086_lib_diag.sh:732`, `$12+$13` are utime and stime).
  - A thread that exits between samples is dropped. A new thread shows as `new`.
- **Timing.** Sample A is taken when the probe sees a new tip, and sample B 10 s later, so the
  window spans a new-block build. A second pair, taken mid-way between blocks, is the idle
  baseline.
- **Output.** The top 8 threads by CPU %, plus host steal and iowait over the same 10 s from
  `/proc/stat`.
  - The **stratum thread** is the one whose `comm` is `stratum_server`. Grin names it in
    `servers/src/grin/server.rs:384-385`. It fits the 15-character comm limit.
  - Expected stratum CPU over the window ≈ build time / 10 s. The incident's 92–100 % fits an
    8 s build.

### 10.6 Stack capture

**Asks first, default No.** The capture attaches with ptrace, and that stops every thread of the
node while it runs: a fraction of a second for eu-stack, several seconds for gdb while it loads
symbols. Mining, P2P and the API all wait during that pause. The prompt says so, names the pid,
and says how many pauses the run makes (three, see Trigger).

- **A Ctrl+C or a hung tool must never leave the node stopped.** Each tool runs under
  `timeout -s KILL 30` in its own session (`setsid`), so a Ctrl+C in 086 does not reach it
  mid-attach. The kernel detaches a tracer that exits, but a tracer killed between its attach
  stop and its detach can leave the process in the stopped (`T`) state.
  - So after every capture, and from key 8's cleanup path, key 8 reads the state of each
    `/proc/<pid>/task/*/stat` and `TracerPid` in `/proc/<pid>/status`. Untraced threads in
    state `T` get one `kill -CONT <pid>`, and the screen says so.
  - That `SIGCONT` is the only signal key 8 ever sends, and only to undo its own capture
    (§10.9).

- **Tools, in order:**
  1. `eu-stack -p <pid>` (elfutils);
  2. `gdb -p <pid> -batch -ex 'thread apply all bt'`, plain `bt` with no `full`, so no local
     values are printed;
  3. `perf record -t <lwp> -g -- sleep 3` then `perf report --stdio`. perf samples without
     stopping the node, but it needs symbols to be useful.
- **Missing tools.** Key 8 offers `apt-get install elfutils gdb` or `dnf install elfutils gdb`,
  **default No**. It never installs anything without a `y`.
- **Trigger.**
  - With Debug on, tail the log for a fresh `resend updated block` and capture 1 s after it.
  - Otherwise, capture 1 s after the probe sees a tip change.
  - Three captures 2 s apart in the same build show whether the thread sits in one frame or
    moves.
- **Extracting the stratum thread.** Its LWP is found **before** attaching, from the
  `/proc/<pid>/task/<lwp>/comm` == `stratum_server` scan in §10.5.
  - eu-stack: keep the `TID <lwp>:` block.
  - gdb: keep the `Thread … (LWP <lwp>)` block.
  - The other threads go into the saved file, not onto the screen. The exact header formats of
    both tools are to be checked on a real box (**UNVERIFIED**).
- **stderr is never discarded.** Each tool's stderr goes to the report next to its stdout and is
  shown when the tool fails.
  - When attach fails, the screen prints `kernel.yama.ptrace_scope` from
    `/proc/sys/kernel/yama/ptrace_scope`. 0–2 allow root, which holds CAP_SYS_PTRACE; 3 blocks
    every attach until reboot.
  - Inside a container, a missing CAP_SYS_PTRACE gives the same error. The screen says both.
- **Symbols.** Whether official release tarballs and `cargo build --release` source builds keep
  enough symbols for useful frames is **UNVERIFIED**. A capture made only of `??` frames is
  reported as "no symbols", not as a result.

### 10.7 Baseline and A/B

**Files.** Each run writes two files at the top level of `REPORT_DIR` (`/opt/grin/reports/diag`,
mode 700, `086_grin_diagnostics.sh:52, 227-230`), each mode 600:

- `stratum_<net>_<YYYYmmdd_HHMMSS>.txt`: the screen, plain text.
- `stratum_<net>_<YYYYmmdd_HHMMSS>.json`: the baseline record, at the top level so key 6 lists it.
- **Key 6 deletes the screens, never the baselines.** `saved_reports` deletes only `grin_diag_*`,
  `api_perf_*` and `consumer_load_*` (`086_grin_diagnostics.sh:602-605`). Its two `find` name lists
  gain `-o -name 'stratum_*.txt'` and nothing else. A `.json` baseline survives the cleanup, so a
  before/after Compare still works months later; each one is under 2 KB. Key 6 lists them, and the
  operator removes one by hand if needed (operator decision, 2026-10-28).

```json
{"v":1,"kind":"stratum_latency","net":"mainnet","at":"2026-10-28T05:12:40Z",
 "binary":{"user_agent":"MW/Grin 5.5.2.ab12cd3","sha256":"<64 hex>","source_ref":"pr/3939",
           "commit":"<40 hex>","toolkit_patches":["0001-x.patch sha256:<64 hex>"],
           "provenance":"source_build|archived_release|release|no_record|swapped"},
 "config":{"stratum_addr":"127.0.0.1:3416","attempt_time_per_block":15,"file_log_level":"Info",
           "poll_ms":200},
 "probe":{"n":5,"p50_s":8.41,"p95_s":16.52,"max_s":16.52,"bound_s":0.24,
          "refresh_p50_s":23.4,"deadline_build_s":8.4,"reorgs":0,"queued":1,
          "stale_on_arrival":0,"superseded":0,"loss_pct":16.7,"block_interval_s":59.8,
          "rows":[{"tip":3971001,"seen":"…Z","job":"…Z","lat_s":8.19,"flags":[]}]},
 "log":{"available":false},
 "rejects":{"window_h":6,"stale":117,"low_diff":0,"invalid":0,"accepted":3105,"pattern":"steady"},
 "cpu":{"stratum_server_pct":94.0,"steal_pct":0.3,"iowait_pct":0.1}}
```

**Binary fingerprint.** Taken from the **running** process, never from the file on disk:

- `user_agent` from `get_status`. Grin builds it as `MW/Grin <version>.<git short hash>` when
  the build saw a git checkout (`p2p/src/msg.rs:49-55`), so a source build already names its
  commit. Whether official release binaries carry a hash too is **UNVERIFIED**, so the user
  agent is never used to tell a release from a source build.
- `sha256` of `/proc/<pid>/exe`. This reads the running image even after the file on disk was
  replaced; 086 already flags that case (`086_lib_diag.sh:444-446`).
- `source_ref`, `commit` and `toolkit_patches` come from `<dir>/.grin_binary_info`. Three writers
  produce that file, in different shapes:
  - Script 01 key G: `artifact =` a local store path (`01_lib_source_build.sh:924`),
    `source_ref = …` for a real source build (`:932`), then the artifact's `.info` appended as
    `# ` comments (`:933`): `# commit = …`, `# toolkit_patch = <name> sha256:<hex>`
    (`:478-496`), or `# sha256 = …` for an archived release (`:692-701`).
  - 081 binary push: the same shape, but `artifact =` is a path on the **controller**, not on
    this box (`081_lib_binary_push.sh:133-140`).
  - 081 remote upgrade: header "official release", `artifact =` a release tag
    (`081_host_monitor_port.sh:1540-1547`).
  - Script 01's release install and update **delete** the file (`01_lib_node_ops.sh:322`), so
    a node on an official release installed by Script 01 has none.
- The store is `GSB_BIN_DIR=/opt/grin/bin` (`01_lib_source_build.sh:65`; layout `:27-33`).
- **`provenance`**, from that file:
  - `source_build`: it has `source_ref =` or a `# commit =` line;
  - `archived_release`: it has a `# sha256 =` line;
  - `release`: its header says "official release";
  - `no_record`: there is no file. This is the normal state of a Script 01 release install, and
    of a hand install. It says nothing either way.
  - Then, when `artifact =` names a file that exists on this box, it is hashed and compared with
    the running exe. A source build's `.info` carries no sha256 of the binary, so this is the
    only check. A mismatch turns any of the above into `swapped`: the record no longer describes
    the binary that runs.

**Compare screen** (key 8 → `C`):

- It lists saved baselines for the net, newest first, with user_agent, short sha and p95. The
  operator picks two. The default pair is the newest run of the running sha against the newest
  run of a different sha.
- It prints the metrics side by side: p50, p95, max, deadline-build, loss %, stale %, stratum
  CPU %, and Δ.
- Two runs of the **same** sha differing by more than 2× are flagged "host noise likely; repeat
  both".
- A row whose `config` differs (poll_ms, attempt_time_per_block) is marked, because the numbers
  are not comparable.

### 10.8 Integration

**Quick check (key 1).**

- Key 1 does **not** run the probe, because one block takes about a minute and key 1 is a 30 s
  check.
- It reads the newest `stratum_<net>_*.json` whose `binary.sha256` equals the running exe's hash.
- **p95 > 2 s → WARN**, area `Node <net>`, title "Stratum template latency p95 N s". Observed:
  "n blocks, measured <date>, binary <user_agent>".
- It needs n ≥ 3. A record with fewer blocks gives INFO "Template latency: only n blocks
  measured; run key 8 again".
- **Likely-origin lean:**
  - `host` when CPU steal > 5 % or PSI cpu avg60 > 10 during the run, because a CPU-bound build
    slows down on a starved host whatever the binary;
  - otherwise `upstream`: the template is built by grin's own stratum loop.
  - The observed text names the provenance (§10.7), for example "source build pr/3939" or "no
    install record". `no_record` is the normal state of a Script 01 release install, so it is
    never worded as "not a release build".
- The hint says it is a lean: "origins are pattern-based leans, not a diagnosis". This is the
  rule of §1 and `_render_origin_tally` (`086_grin_diagnostics.sh:170-191`).
- With no matching record: INFO "Template latency not measured for this binary. Run key 8."
- Mainnet and testnet are judged separately.

**Support bundle (key 2): `11_stratum_<net>.txt`.** One file per running node with stratum
enabled, written after `10_recorder.txt` (`086_grin_diagnostics.sh:372`). It holds:

- the stratum config keys;
- the binary fingerprint;
- §10.3 when DEBUG lines exist, else the Info notice;
- §10.4 over 24 h;
- one §10.5 sample, not tip-aligned;
- the newest saved probe report for that net.

The bundle does **not** run a live probe, because that would add minutes. Its `00_summary.txt`
list (`:392-401`) gains the row
`11_stratum_<net>.txt   stratum latency: config, build log, rejects, threads, last probe`.

The file passes through `dg_redact` like the bundle's other text (`086_lib_diag.sh:72`). That
removes any run of 20 or more `[A-Za-z0-9+=]`, so the full sha256 and the 40-hex commit do not
survive. The file therefore prints the 12-hex short sha and the user agent, which do, and keeps
the full values in the local `.json` baseline only.

**Signature rows in `scripts/lib/grin_log_signatures.sh`.** The table is ordered, the first match
wins, and the regexes are mawk-safe lower-case ERE (`:22-26`). Two rows go in, **directly before
the `chain-corrupt` row** (`'invalid ?root|corrupt|txhashset.*(invalid|fail)'`, `:35`), first
`stale-share`, then `bad-share`:

| RE | NAME | ORIGIN | HINT |
|---|---|---|---|
| `'submitted too late'` | `stale-share` | `consumer` | "A share arrived after the node moved to a new tip. A steady rate (10 or more in the window) points to slow template builds on the node; bursts point to quick blocks or a reorg. Measure it with Diagnostics key 8." |
| `'rejected due to low difficulty\|failed to validate (solution\|share)'` | `bad-share` | `consumer` | "The node rejected a miner's submission as invalid or below the share difficulty. Check the miner's config; key 8 lists these per hour." |

- **Why that position.** A `Failed to validate solution … <error>` line prints the
  `process_block` error (`stratumserver.rs:426-435`). An error text that contains
  "invalid root" or "corrupt" would match the `chain-corrupt` row first and be mis-tagged as chain
  corruption (which error texts can appear there is **UNVERIFIED**). The stale line contains none
  of the earlier rows' words, but it must come before the generic `stratum` row (`:39`), and one
  insertion point serves both rows.
- **No `{n}` intervals.** In the bash array the `|` is written literally. The `\|` above only
  escapes the markdown table.
- **Keep the four arrays index-aligned** (`:12-14`).
  - The recorder renders `.sigcounts` into `summary.txt` in the same run that wrote them
    (`grin_node_events.sh:1084-1093, 1443-1446`), so shifting the indices does not mislabel old
    bundles.
  - The recorder's installed copy picks the rows up on its next install (`:2442`).
- **Severity in `_dg_triage_finding`** (`086_lib_diag.sh:272-286`):
  - `stale-share` is WARN when stale / (accepted + stale) > 3 %, matching Solo Health's yellow.
    This needs `dg_triage` to also count `got share at height` lines in the same window, since
    it reads only ERROR/WARN lines (`:228`). Without accepted lines, WARN above 10 per hour.
  - `bad-share` is WARN above 10 per hour.
  - Otherwise both are INFO.

**Optional solo section.** Shown only when `/opt/grin/solo-stats/solo_mining_stats_main.db` (or
`_test`) exists (`07_grin_mining_solo.sh:81`, `07_mining_block_collector.py:1593`):

- It opens the database **read-only** (`sqlite3` URI `mode=ro` from `python3 -I`, with a 5 s
  busy timeout) and runs two short queries. The collector's DB is in rollback-journal mode, so a
  reader's shared lock can delay the collector's commit for those milliseconds. The collector
  connects with a 30 s busy timeout (`07_mining_block_collector.py:337`), so it waits, never
  fails. Nothing is written.
- It prints the last 7 UTC days of `share_quality` (accepted, stale, rejected,
  `07_mining_block_collector.py:314`) and the solo binary-change marker
  (`script07_reference_solo_flowchart.md`, "Node binary change marker").
- A collector older than the marker has no `node_binary_changes` table. The section then prints
  the counts alone and says "binary marker: not recorded by this collector version".
- An operator can then see a stale rise against the day the binary changed.
- The pool's logs are out of scope for now (§10.9).

**Menu.**

- `show_menu` (`086_grin_diagnostics.sh:1436-1458`) gains, under **Dig deeper** after row 5:
  `8)   Mining / stratum latency  template delay · stale shares · threads`. The key is `CYAN`
  like rows 3 and 4, not the `YELLOW` of row 5, because the default run changes nothing on the
  node; the label is padded to the same 26 columns, and the hint is `DIM`.
- The read-only footer (`:1456`) becomes
  `Read-only except option 5 (and 7's install/settings, 8's optional installs). Reports: …`.
- The prompt becomes `Select [0-8]`.
- The dispatch gains `"8") stratum_latency || true ;;` (`:1469-1477`).
- The file header's key list (`:8-18`) and §2's table gain the row.
- Key 8 has a small sub-menu:
  - `1` probe;
  - `2` log view;
  - `3` rejects;
  - `4` threads;
  - `5` stack capture (asks);
  - `C` compare;
  - `0` back.
  - The default action of `8` then Enter is `1` followed by `3` and `4`, which is mock A.

### 10.9 Privacy, limits, open items

**Privacy** follows §5:

- The secret never reaches argv (§10.2.5).
- Saved files keep heights, job ids, timestamps and thread names. They never keep `pre_pow`,
  nonces or proofs.
- Reject lines shown on screen pass through `dg_redact`, which removes the 64-hex hashes.
- Stack captures use plain `bt`, never `bt full`, so no local variable values. They do contain
  binary paths and addresses, and the screen says so before the file is shared.
- The solo section prints counts only.

**Key 8 never:**

- changes `file_log_level`, or any toml key;
- restarts or stops a node. The only signal it may send is the `SIGCONT` of §10.6, which undoes
  a capture that left the node stopped;
- submits a share or asks for `status`;
- connects to a non-local stratum address;
- installs a package without a typed `y`;
- attaches a debugger without a typed `y`.

The only other node-side effects are the ones §10.2.4 lists, shown before the run: one extra
stratum connection, and template builds on a node with no other stratum client (behind the
`[y/N]` gate and the wallet-listener check).

**Decided by the operator (2026-10-28):** the single `SIGCONT` after a failed stack capture is
allowed (§10.6); key 8 refuses on a node with no other stratum client while the wallet listener is
down (§10.2.4); both `stale-share` and `bad-share` signature rows ship (§10.8); key 6 keeps the
`.json` baselines (§10.7).

**Open items:**

- **Thresholds are untested.** The 2 s p95 WARN, the 3 % stale WARN and the burst/steady rules
  come from one incident.
- **PR #3939's code path is UNVERIFIED.** Every mechanism above is v5.5.2. Segment C points at
  `set_txhashset_roots` on v5.5.2. Whether the staging build changed that call, the lock scope
  or the loop needs a read of the PR diff.
- **Two figures disagree.** "117 rejects in 6 h" is about 20 per hour, but "3–6 a minute" is
  180–360 per hour. Which window or log was each counted from?
- **Badge vs estimate.** The incident had a 6.6 % badge against a 13 % estimate. It is not known
  whether the pool's badge denominator or its relay explains the gap. Compare once a probe and a
  badge reading come from the same hour.
- **Bundle and probe.** Should the bundle run a short live probe (2 blocks, about 2 minutes) when
  no baseline for the running binary exists?
- **Stack captures.** The header formats of eu-stack and gdb, and the symbol coverage of release
  binaries (§10.6).
- **Pool logs.** Reading the pool backend's stale counts is out of scope for now.

### 10.10 Screen mock (80 columns)

Conventions, taken from 086 as it is: the `_banner` header; section heads in the
`── <name> ────` form `_render_findings` uses (`086_grin_diagnostics.sh:145-166`); a finding as
`[SEV]  title  (likely: <origin>)`, then the observed line, then the hint; the closing marker
from `ui_end` (`scripts/lib/ui_shared_helpers.sh:179-189`). No line is wider than 79 columns, so
nothing wraps in an 80-column terminal. The verdict comes first, the evidence after it, and
every degraded state ends with what to do next.

A, the normal run at Info logging:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 086)  Diagnostics & Support Bundle
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Mining / stratum latency · mainnet · 2026-10-28 05:12 UTC

  [WARN]  Template latency p95 16.5 s  (likely: upstream)
        p50 8.4 s · 5 blocks · healthy is under 0.5 s
        loss ≈ 16.7 % of hashrate (node part only)
        Origins are pattern-based leans, not a diagnosis. The build runs in
        grin's own stratum loop; the host showed no CPU pressure.

  node     /opt/grin/node/mainnet-prune · pid 41822 (exe match)
  binary   MW/Grin 5.5.2.ab12cd3 · sha 9f3c1e0a7b2d · source build pr/3939
  stratum  127.0.0.1:3416 · refresh 15 s · log Info · 2 other connections

── Template latency (probe, 5 blocks, poll 200 ms) ──────────
  tip       seen (UTC)    first job      latency   flags
  3971001   05:03:12.4    05:03:20.6      8.19 s
  3971002   05:04:01.9    05:04:10.3      8.41 s
  3971003   05:05:30.2    05:05:46.7     16.52 s   queued
  3971004   05:06:02.0    05:06:10.4      8.37 s
  3971005   05:07:15.8    05:07:24.2      8.47 s
  p50 8.41 s · p95 16.52 s · max 16.52 s   (true value up to +0.24 s)
  refresh interval p50 23.4 s → deadline build 8.4–9.4 s
  loss ≈ 10.0 s / 59.8 s ≈ 16.7 %   (miner link and pool relay not included)

── Node rejects (log, 6 h) ──────────────────────────────────
  stale 117 · accepted 3 105 · low-diff 0 · invalid 0 → stale 3.6 %
  pattern: steady (6 of 6 hours), the signature of slow template builds

── Threads (10 s across a new block) ────────────────────────
  stratum_server   94.0 %    tokio-runtime-w   3.1 %    grin   1.2 %
  host steal 0.3 % · iowait 0.1 %

── Build log ────────────────────────────────────────────────
  Build lines are DEBUG; this node logs at Info. To see where the time
  goes, set  file_log_level = "Debug"  under [logging] in
  /opt/grin/node/mainnet-prune/grin-server.toml, then restart the node
  through the toolkit. Debug writes several times more log; set it back
  afterwards. 086 does not change it.

  Next: measure another binary on this node. Roll back (Script 01 → key G,
  option 4), run key 8 again, then key 8 → C to compare the two.
  Saved  /opt/grin/reports/diag/stratum_mainnet_20261028_051240.json
  One probe connection was open for 5 min 12 s. Nothing on the node changed.

────────────────────────────────────────────────────────
  [END]  1 warning · nothing was changed
────────────────────────────────────────────────────────
```

B, the build log when DEBUG lines exist (replaces the Info notice):

```
── Build log (DEBUG, 1 h, 61 new-block / 152 refresh builds) ─
  trigger     total p50/p95    A coinbase   B assemble   C roots+state
  new block   8.32 / 8.51 s    0.009 s      0.126 s      8.18 s
  refresh     8.29 / 8.47 s    0.008 s      0.119 s      8.16 s
  slowest (log time): 04:52:31.118 → 04:52:39.731  8.61 s  (C 8.47 s)
  C = set_txhashset_roots + state update (v5.5.2 path; see 086 §10.3)
```

C, stratum disabled:

```
  Mining / stratum latency · testnet

  [INFO]  The stratum server is OFF on this node  (likely: config)
        /opt/grin/node/testnet-prune/grin-server.toml
        enable_stratum_server = false
  There is nothing to measure. To mine on this node, set
    enable_stratum_server = true
  under [server.stratum_mining_config] and restart the node through the
  toolkit, or run the solo or pool setup, which does both.

────────────────────────────────────────────────────────
  [END]  stratum disabled · nothing was changed
────────────────────────────────────────────────────────
```

D, the node runs but does not answer:

```
  Mining / stratum latency · mainnet
  node  /opt/grin/node/mainnet-prune · pid 41822 (exe match), up 3 d

  [CRIT]  Node API did not answer  (likely: host)
        127.0.0.1:3413 get_status: no reply within 2 s
  [CRIT]  Stratum did not answer  (likely: config)
        127.0.0.1:3416 refused the connection
  A pruned node can freeze for about 100 s while it compacts. Wait two
  minutes and run key 8 again. If it still fails, read the node log with
  key 4, and key 7 for what the node did recently.

────────────────────────────────────────────────────────
  [END]  node not answering · nothing was measured
────────────────────────────────────────────────────────
```

E, the gate on a node with no other stratum client (§10.2.4). The first form refuses; the
second asks:

```
  Mining / stratum latency · testnet
  No miner or pool is connected to this node's stratum port (127.0.0.1:13416).

  [WARN]  Wallet listener not reachable  (likely: consumer)
        http://127.0.0.1:13415 refused the connection
  Not run. With no other client, the probe's connection would make the node
  start building templates, and every build calls this wallet. With the
  wallet down, the build retries every 5 s with an ERROR line in the node
  log, and that does not stop when the probe leaves. Start the wallet
  listener first, or measure while a miner is connected.

────────────────────────────────────────────────────────
  [END]  not run · nothing was changed
────────────────────────────────────────────────────────
```

```
  Mining / stratum latency · testnet
  No miner or pool is connected to this node's stratum port (127.0.0.1:13416).

  While the probe is connected, the node builds a block template about
  every 15 s and at every new block, and asks the wallet listener at
  http://127.0.0.1:13415 for a coinbase each time. It stops when the probe
  disconnects. The listener accepted a connection, but that does not prove
  it answers coinbase requests: if the probe sees no job, stop it with
  Ctrl+C and check the node log for "Can't connect to wallet listener".
  Nothing else on the node changes.

  Run the probe anyway? [y/N]:
```

F, degraded runs:

```
  [INFO]  python3 not found: the probe cannot run  (likely: host)
        Log view, rejects and threads below still ran. Install python3
        (apt-get install python3 / dnf install python3), then run key 8.
```

```
  [INFO]  Node is syncing: the probe did not start  (likely: network)
        The probe measures only a synced node. Run key 8 again once
        Script 01 status shows the node synced.
```

```
  3971120   05:41:07.3    —               —        no-job (120 s)
  [WARN]  No job for a new tip in 120 s  (likely: consumer)
        Look for "Can't connect to wallet listener" in the node log:
        a build that cannot get a coinbase never finishes.
```
