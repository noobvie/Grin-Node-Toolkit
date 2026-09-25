# Script 086 — Diagnostics & Support Bundle

> **Covers code as of:** 2026-09-25 · **Last verified:** never systematically verified
> **Product code last changed:** 2026-09-25 — `scripts/086_grin_diagnostics.sh`, `scripts/lib/086_lib_diag.sh`

**Status:** built 2026-09-25, **never run on a VPS.** Only `bash -n` and a local test of the
log-triage and TOML-flattening functions on sample data have run.
**Menu:** hub 08, key `6`.
**Files:** `scripts/086_grin_diagnostics.sh` (menu, rendering, bundle),
`scripts/lib/086_lib_diag.sh` (probes, log triage, collectors).

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
