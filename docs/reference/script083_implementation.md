# Script 083 — Host Optimization & Hardening: implementation

> **Covers code as of:** 2026-11-01 · **Last verified:** never systematically verified
> **Product code last changed:** 2026-11-01 (uncommitted) — `scripts/083_host_optimization.sh`, `scripts/lib/083_lib_*.sh`, `scripts/lib/08_lib_host_updates.sh`, `scripts/lib/081_lib_host_updates.sh` (+ its menu key in `scripts/081_host_monitor_port.sh`)
> **Scope:** the architecture, checks and conventions as built, plus the Build notes. The rationale (why advisory-only, SSH routing, menu keys, the update policy) is `script083_design.md`.

**Status:** built, **never run on a VPS.** Read-only advisor plus one apply path, Automatic
Security Updates (key `9`).
**Menu:** hub 08, key `3`.
**Files:** `scripts/083_host_optimization.sh`, `scripts/lib/083_lib_profile.sh`,
`scripts/lib/083_lib_advice.sh`, `scripts/lib/08_lib_host_updates.sh`; the fleet side of the
updates is `scripts/lib/081_lib_host_updates.sh` (081 Mass Deployment key `5`).

## What shipped

### Architecture

```
083_host_optimization.sh     menu, rendering, export, dispatch to 085
  lib/083_lib_profile.sh     facts   — every fn echoes ONE value or "unknown"
  lib/083_lib_advice.sh      checks  — facts → scored findings
  lib/grin_node_secrets.sh   grin_live_node_dir() for per-node peer sizing
  lib/08_lib_host_updates.sh key 9 — OS security updates (hu_), shared with 081
```

Findings are six parallel arrays (`ADV_SEV/AREA/TITLE/OBS/REC/FIX`) appended by `adv_add`.
Severities: `CRIT` (live risk) · `WARN` (bites under load or on reboot) · `INFO` · `OK`
(checked and healthy — printed so a clean box reads as *verified*, not as a check that
silently didn't run) · `NA` (not applicable on this host).

Shared UI helpers (`[END]` marker, `q`-to-cancel prompts) are in `scripts/lib/ui_shared_helpers.sh`; their contract is in *Build notes · Screens and prompts*.

### What is checked

| Area | Checks | Grin-specific reason |
|---|---|---|
| CPU | cores, model, **steal %**, load/core | Steal is the number nobody looks at and the one no local tuning fixes — a "change plan" finding, worth knowing before spending a week on a sync. |
| Memory | RAM, swap vs RAM-sized target | Cold start rebuilds the output MMR bitmap accumulator single-threaded. An OOM-kill mid-rebuild doesn't resume — it restarts, presenting as a node permanently "still syncing". |
| Kernel | swappiness, vfs_cache_pressure, somaxconn, netdev_max_backlog, THP | Chain files are mmap'd, so page cache *is* node speed. THP `always` + LMDB inflates RSS and adds compaction stalls. |
| Disk | free/used, rotational, IO scheduler, atime, fstrim | Archive `chain_data` is 18 GB+; sync is heavily random-read. |
| Node | `nofile` soft/hard, `peer_max_inbound_count` vs RAM | One socket per peer + LMDB/MMR handles. A 1024 fd limit under a 999 peer cap fails only once peers climb — i.e. long after anyone is watching. |
| Time | active timesync unit, `NTPSynchronized` | A drifted clock gets the node peer-banned, and fails looking like a network problem. |
| Logs | journald `SystemMaxUse` | Uncapped journal = slow disk-full weeks after someone enabled debug logging. |
| Security | ufw state, **node API bind address**, wallet listener bind, fail2ban, unattended-upgrades, pending security updates | See below. |
| SSH | port, `PermitRootLogin`, `PasswordAuthentication` | Read-only; routes to 085. |

#### The highest-value security check

Ports 3413/13413 carry no auth beyond a shared secret and were never meant to face the
internet. 083 reads the **bind address** from `ss` and grades it against firewall state:

- **not** loopback (`0.0.0.0`, `[::]`, or any specific public IP) **and** no active
  firewall → `CRIT`, exposed right now
- **not** loopback **with** ufw up → `WARN`, the firewall is the only thing in the way
- every listener on the port is loopback → `OK`

Script 04 remains the supported way to publish chain data — it serves the **foreign** API
only and 403s the owner API.

#### On the sizing numbers

The peer-limit tiers (25 / 50 / 100 by RAM) are **toolkit heuristics, labelled as such in the
finding text**, not measured limits. Script 01's `999` is correct for a community seed node on
a well-resourced box; the check exists to catch the mismatch on a small one, not to argue with
the default. The finding says so explicitly and tells the operator to raise it once they can
watch memory under load.

### Automatic Security Updates (key 9)

**Status:** built, not VPS-tested. Policy and rationale → `script083_design.md` §10.

Key `9` opens `hu_menu`: `1` status (read-only), `2` enable (on apt asks the NodeSource
opt-in, default No; then confirms), `3` disable (confirms), `4` run security patch now
(confirms), `5` last patch run (read-only), `0` back. Success needs exit 0 **and** a final
`__OK__`. A failed status read logs its output and stderr. The wrappers default every colour
and `LOG_FILE`, and define fallback `log`/`info`/`warn`/`error`/`success` when the caller has
none, so 081 can reuse them under `set -u`.

083 is always used over SSH, so nothing it starts may depend on the session:
- **Enable / disable** stream through `hu_run`. `hu_script` opens both snippets with
  `trap '' HUP PIPE`; `hu_run` ignores INT and HUP for the whole pipeline (inherited by every
  stage) and its `tee --output-error=warn-nopipe` keeps writing the log copy after the
  screen-side reader is gone. Package output inside enable is captured into a variable, never
  streamed, so a dead reader cannot reach apt or dnf. Checked by HUPping the process group of a
  slow stub with its reader already dead: the log still ends in `__OK__` and rc 0.
- **Run security patch now** is not streamed at all: it is started detached through the shared
  launcher (*Detached patch runs* below), then `hu_follow_run` prints the log as it grows (poll
  every 2 s, up to `HU_WATCH_MAX` s, default 1800). Ctrl-C or a dropped session (HUP) ends the
  following only; key `5` shows the newest run's result and log tail later.

Text read back from a snippet or a log goes through `_hu_clean` (strips C0 controls except tab
and newline, and DEL) and is printed only as a `printf %s` argument, never via `echo -e` or a
format string.

**Snippet interface** (for 081 Mass Deployment): `hu_script <action> [nodesource=yes|no]`
prints a complete bash script — env lines (`HU_NODESOURCE=…`, and `HU_TEST`/`HU_ROOT`, blank
outside test mode), the shared prelude, the body. Run it with `bash -s` locally or
`ssh … bash -s` remotely, as root. Output is plain text; the last line is `__OK__` on
success, failures print `ERROR: …` and exit non-zero (1 runtime, 2 bad input).

| Action | Effect | Output |
|---|---|---|
| `status` | read-only; never takes the dpkg lock; dnf probes cache-only under `timeout` | `family distro auto_updates toolkit_policy security_only pending_security reboot_required services_restart needrestart_policy nodesource_origin php_repo lock_busy` as `key=value` (list in `HU_STATUS_KEYS`), then zero or more `note=` lines |
| `enable` | idempotent install + configure, then a fatal read-back | `installed:` / `backed up:` / `wrote:` / `skip:` lines; apt adds `effective_origin=` lines; one `check:` line; any mismatch prints `ERROR:` lines and exits 1 with no `__OK__` (files stay) |
| `disable` | changes only marker-carrying files; schedule and timers off | `removed:` / `wrote:` / `restored:` / `disabled:` / `kept:` / `WARN:` lines, then the **read-back** `auto_updates=on|off` (+ `WARN:` if still on) |
| `run-now` | re-checks the policy, then one security-only pass | refusal `ERROR:` if not security-only or reboot allowed; else the package manager's own output, then `reboot_required=` and `services_restart=` |

`enable` and `disable` open with `trap '' HUP PIPE`. `run-now` is meant to be wrapped by
`hu_launch_script` and never streamed:

**Detached patch runs** (`hu_launch_script <run-now script>`, `hu_poll_script <id|""> <tail>`,
shared by 083 key 9 → 4/5 and 081 Mass Deployment key 5 → 4/5). Reply lines are `HUR|key|…`
then `__OK__`.
- The launcher (`trap '' HUP PIPE` first) makes `/var/lib/grin-toolkit` and `host-updates/`
  under umask 022 if missing (they stay 755, shared with enable's state), then `run-now/` 700
  and `/var/log/grin-host-updates/` 750. It takes a `flock` on `run-now/.lock` and holds it from
  the busy check until the record is written, so two simultaneous starts cannot both pass;
  a held lock → `HUR|busy|(starting)|`, a live run → `HUR|busy|<id>|<log>`, both with `ERROR:`.
- It writes the snippet (sent as base64) to `run-now/run-now.sh` (700, temp + `mv`) and starts
  `run-now/wrap.sh` — a file, because systemd expands `$` in a unit command line — under
  `systemd-run --unit=grin-hu-runnow-<UTC> --collect -p IgnoreSIGPIPE=no` (systemd ignores
  SIGPIPE in services by default), or `setsid nohup` when systemd is absent or refuses; that
  subshell resets the launcher's PIPE trap first, since an ignored SIGPIPE is inherited across
  exec. fd 9 (the lock) is closed in the child.
- Output goes to `/var/log/grin-host-updates/run-now_<YYYYmmdd_HHMMSS>.log` (UTC); the exit
  code to `run-now/rc_<id>` only after the snippet returns. `run-now/current` records id, log,
  rc file, unit or pid. Reply: `HUR|started|<id>|<log>|<systemd-run|setsid>`.
- The poll is read-only: `HUR|state|` none / running / done / vanished (no rc file and no live
  unit or pid — killed, or rebooted under) / other (a newer run than the id asked for), plus
  `id`, `log`, `how`, `rc`, `lines`, `last`, `kv` (`reboot_required=` / `services_restart=`) and
  `tail` lines. A run is OK only with state done, rc 0 and last line `__OK__`.
- In test mode both dirs move under `HU_ROOT`, like the snippets' paths.

Values: `auto_updates` on/off/unknown · `toolkit_policy` present/absent · `security_only`
yes/`yes+nodesource`/no/n/a · `pending_security` a count or unknown · `reboot_required` yes/no/unknown ·
`services_restart` comma list/none/unknown · `needrestart_policy` present/absent/n/a ·
`nodesource_origin` allowed/not-allowed/n/a · `php_repo` distro/none/`third-party:<files>` ·
`lock_busy` yes/no/unknown.

Files written (all mode 644, written to a `*.bak` temp then `mv`, carrying the marker
`Written by Grin Node Toolkit (host updates)`):

| Family | File | Disable |
|---|---|---|
| apt | `/etc/apt/apt.conf.d/20auto-upgrades` (`Update-Package-Lists`, `Unattended-Upgrade` = 1) | rewritten with both = 0 — only while it still carries the marker, else `WARN` and left |
| apt | `/etc/apt/apt.conf.d/52grin-unattended-upgrades` (`#clear` + security origins + `Automatic-Reboot "false"`) | deleted if marked |
| apt | `/etc/needrestart/conf.d/50-grin.conf` (`restart = 'l'`), only if `/etc/needrestart` exists | deleted if marked |
| dnf | `/etc/dnf/automatic.conf` (`upgrade_type = security`, `apply_updates = yes`, `reboot = never`) | pre-enable copy restored whenever it exists (state file or not); else deleted if marked; an unmarked file gets `WARN` and is left. `dnf[5]-automatic.timer` and dnf 4's `dnf-automatic-install.timer` disabled |
| both | `/var/lib/grin-toolkit/host-updates/state` (what was written) + `<file>.pre-enable` copies, taken once | state deleted, copies kept |

A `.pre-enable` copy is taken once per host and never refreshed: a later enable, even after
disable has deleted the state file, keeps the first copy (an existing `.pre-enable` is never
overwritten). It therefore shows the file as it was before the toolkit first touched it, not
before the most recent enable.

**Installs are time-capped only where they can hang without harm.** apt downloads
`unattended-upgrades` with `apt-get -d` under `timeout 900` (`apt-get update` under 300) and
then installs from the downloaded archive with no timeout beyond `DPkg::Lock::Timeout=120` —
killing apt-get once dpkg runs would leave half-configured packages. dnf follows the same rule:
`dnf install --downloadonly` runs under `timeout 900` (dnf has no lock timeout), and the
cache-only `dnf install -C` that follows is not capped, because killing rpm mid-transaction can
damage the rpm database. A timeout prints its own `ERROR: … timed out` line.

**Enable read-back (fatal).** apt: the effective origin list must be exactly security
(`yes`, or `yes+nodesource` when opted in), `Automatic-Reboot` must not be true, both
`APT::Periodic` values non-zero, and `apt-daily.timer` + `apt-daily-upgrade.timer` must be
on (`enabled`/`static`/…; `disabled`, `masked` and systemd 255's `not-found` are off). A
masked timer is not unmasked — that was an operator decision; the error says how. On a host
without a running systemd the `apt-compat` cron job counts as the schedule. dnf:
`upgrade_type = security`, `reboot = never`, the timer enabled and applying. Status, like
apt's `Automatic-Reboot`, adds a note when the effective dnf `reboot` is anything but `never`
(security-only stays as read); run-now is unaffected, since `dnf upgrade` never reboots.

`run-now` on apt re-runs the origin classification and the reboot read-back, refuses on a
mismatch or without the toolkit drop-in, then runs `apt-get update` and `unattended-upgrade
-v`. On dnf it is `dnf upgrade --security -y`. Both wait up to 120 s for a busy package
manager, export `NEEDRESTART_MODE=l`, print a do-not-interrupt line and ignore SIGINT/SIGHUP
around the package run. Every package-manager call in a snippet reads `</dev/null`.

**`HU_ROOT` (test only).** A path prefix on every `/etc`, `/var` and `/usr` path, honoured only
with `HU_TEST=1` beside it — `hu_script` always emits both, blank outside test mode, so a
stray `HU_ROOT` exported in root's environment cannot fake a successful enable, and
`hu_run`/`hu_status_load` warn when one is set. In test mode installs, `systemctl` and the
patch run are skipped (`skip:` lines; run-now still runs its policy checks first), the root
check is waived, apt-config is redirected to the scratch tree through an `APT_CONFIG` boot file
setting `Dir::Etc`, and `HU_FAMILY` / `HU_DNF_VERSION` may force the dnf layout on an apt box.
The read-only probes (`apt-get -s`, needrestart, fuser) still read the real host.

The report's own checks stay light rather than calling the status snippet (which runs
needrestart over every process and, on dnf, `check-upgrade`): `hp_unattended_ok` checks
apt's package + `Unattended-Upgrade "1"`, or on dnf an enabled `dnf-automatic` /
`dnf-automatic-install` / `dnf5-automatic` timer plus `upgrade_type = security` and — unless
the timer is dnf 4's always-apply `dnf-automatic-install` — `apply_updates = yes`;
`hp_pending_security_updates` uses the same `dist-upgrade` simulation as the snippet. Both
`fix:` lines point at key 9 (Enable, and Run security patch now).

The full cleanup (08del) leaves the policy and its state dir in place and says so on its
closing screen when the apt drop-in, the state file or a marked `automatic.conf` exists — not
merely the directory, which a host that only ever had a patch run also has.

#### Remote: Mass Deployment key 5

**Status:** built, not VPS-tested. `081_host_monitor_port.sh` sources `08_lib_host_updates.sh`
to generate the snippets on the controller and `081_lib_host_updates.sh` (`_mdh_`) to send
them; the remote box needs no toolkit files. Mass Deployment → `5) Host security updates`
opens `_mdh_menu`: `1` status, `2` enable, `3` disable, `4` run security patch now, `5` last
patch run, `0` back. Every action first picks servers with `_md_select_servers`.

- **Transport.** The script goes on stdin to a FIXED remote command — `bash -s`, or
  `sudo -n bash -s` when the entry's ssh user is not root — with `$MD_SSH_OPTS` (BatchMode,
  ConnectTimeout, accept-new) plus `ServerAliveInterval=15`, and `--` before the destination.
  User and host must match `^[A-Za-z0-9._@:%-]+$` with no leading `-`, and the port must be
  numeric; anything else is refused before ssh runs. No value is composed into the ssh command
  line; values travel in the script as `printf %q` assignments. Each call runs under `timeout`
  — 300 s status, 1200 s enable/disable, 120 s launch, 60 s poll — reported as TIMEOUT (the
  remote side may still finish; re-read Status). ssh exit 255 is UNREACHABLE. A host counts as
  OK only on exit 0 **and** `__OK__` as the last line. Every reply goes through `_hu_clean`
  and is printed as `printf %s` data.
- **Test values never leave the controller.** Every action refuses while `HU_TEST` or `HU_ROOT`
  is set in the controller's shell, and `_mdh_build` re-checks that the generated header reads
  `HU_TEST=''` / `HU_ROOT=''` before sending.
- **Status** is one table row per server — family, auto updates, security-only, pending,
  reboot required, number of services to restart, lock busy (80 columns) — with UNREACHABLE /
  TIMEOUT / FAILED rows carrying the first error line (60 columns), then per-server notes (the
  `note=` lines, the service names, a policy the toolkit did not write), wrapped at 84 columns.
- **Enable** asks the NodeSource opt-in once for the batch (default No; apt-only, dnf hosts
  ignore it), confirms, then runs each server with its output indented; **disable** confirms and
  ends with each server's real `auto_updates=` line. The snippets' own `trap '' HUP PIPE` keeps
  a dropped or timed-out session from stopping them between two writes.
- **Run security patch now is detached** through the shared launcher (*Detached patch runs*
  above): one launch per server, then polls. The screen says the apt refusal without the
  toolkit policy is apt-only; dnf servers run `dnf upgrade --security`.
- **Watching.** The controller polls every `MDH_WATCH_EVERY` s (default 10) for up to
  `MDH_WATCH_MAX` s (default 1800). Ctrl-C ends the watch only; key `5` reads the newest run
  later. The report gives each server's result, its `reboot_required=` / `services_restart=`
  lines and the last 20 log lines. Nothing reboots: the screens point at Remote node control →
  Reboot servers (key `e`).
- Each action logs to the 081 session log (`[HOST UPDATES]` lines, failing output indented).

## Runbook

Open the tool from hub 08, key `3`. It profiles the host, prints findings by area (CRIT first), pages the full report, and changes nothing. Every finding carries a `fix:` line to run yourself; SSH changes go through 085. Key `9` is the one screen that writes — see *Automatic Security Updates* above.

### Testing the update snippets locally

Never on the dev box's real `/etc`: point `HU_ROOT` at a scratch dir under WSL `/tmp`, with
`HU_TEST=1`.

```bash
source scripts/lib/08_lib_host_updates.sh
hu_script status | sudo bash -s                     # real host, read-only
S=$(mktemp -d); mkdir -p $S/etc/apt/apt.conf.d; cp /etc/os-release $S/etc/
cp /etc/apt/apt.conf.d/50unattended-upgrades $S/etc/apt/apt.conf.d/
export HU_TEST=1 HU_ROOT=$S
hu_script enable nodesource=yes | bash -s
HU_FAMILY=dnf HU_DNF_VERSION=5 hu_script enable | bash -s   # dnf layout
hu_script disable | bash -s; rm -rf "$S"; unset HU_TEST HU_ROOT
```

Checked this way on WSL Ubuntu 24.04: status leaves `/etc/apt`, `/etc/needrestart` and
`/var/lib/grin-toolkit` byte-identical (also with a stray `HU_ROOT` exported and no
`HU_TEST`); enable → disable leaves the tree identical except `20auto-upgrades` (schedule now
0) plus its `.pre-enable` copy; a second cycle keeps the first copy; dnf 4 and dnf 5 restore a
pre-existing `automatic.conf` byte-for-byte, also after the state file is deleted;
unattended-upgrade's own `get_allowed_origins()`, loaded against the scratch tree, returns
exactly the security origins (with `${distro_codename}` substituted); perl parses the
needrestart drop-in to `restart=l`. Fail-closed cases, each `ERROR` + rc 1 + no `__OK__`: a
`60` file with `Origins-Pattern {"origin=*"}` + `Automatic-Reboot "true"` (run-now then
refuses too), `Automatic-Reboot "1"` alone, `Update-Package-Lists "0"` alone. A marker-less
`20auto-upgrades` or `automatic.conf` is left alone with a `WARN`, and disable then reports
`auto_updates=on` honestly. NodeSource opt-in reads `security_only=yes+nodesource`. Snippets
pass shellcheck apart from SC2034 on prelude variables a given body does not use.

The Mass Deployment side was checked the same way, with no real host: a harness sourcing both
libs replaces `ssh` with a shell function that runs `bash -s` locally, rewrites the blank test
header to a per-host scratch `HU_ROOT`, and moves the remote run dir/log dir under it. Covered:
the HU_TEST refusal and the `_mdh_build` header check; the status table from fake outputs (on,
off, unknown, unreachable, failed, notes; widest line 93 columns) and live from apt and dnf
scratch hosts; enable → status → disable with a refused host, an unreachable one and a non-root
user (`sudo -n bash -s`); run-now with a sleeping stub snippet — OK, failing, busy refusal,
watch cap reached, killed run read as ended abnormally, Ctrl-C ending the watch while the run
finished, the `setsid` fallback after a real non-root `systemd-run` refusal and a stand-in
`systemd-run`; and the real run-now snippet through the detached path (refuses without the
policy, passes its checks after enable). Also covered: TIMEOUT rows from a stubbed `timeout`
(status, enable, disable, launch); an unsafe `-oProxyCommand=…` host refused before ssh and
`--` on every call; a host replying with ESC/BEL sequences and literal `\033` / `\c` text
(no control byte reaches the screen, the backslash text prints literally); the launcher's dir
modes (755 / 755 / 700 / 750); a held `run-now/.lock` refusing a second start; the setsid run
seeing default SIGPIPE (`yes | head` → 141); a stand-in `systemd-run` receiving
`-p IgnoreSIGPIPE=no` with fd 9 closed. Locally (083), under `HU_TEST=1`: real enable, a
detached real run-now followed to `__OK__`, Last patch run, HUP while following (following
stops, the run finishes) and the `hu_run` HUP test above. A shell-function `ssh` stub shadowed a
fail-loud `ssh` binary on PATH; real `/var/lib/grin-toolkit` and `/var/log/grin-host-updates`
were never created, and no `grin-hu-*` unit was started.

### Local testing (nothing has run on a VPS)

- `bash -n` on all three files.
- Lib harness exercising every probe on a host where `/proc/mounts`, `systemctl`, `ufw` and
  `apt` are absent or partial — i.e. the "unknown" paths, which are where the arithmetic
  traps live. `adv_run_all` completes without aborting.
- Render harness that `eval`s the **shipped** render functions (not a copy) against:
  populated registry, empty registry, an area with no findings, and long-prose wrapping.
- Table-driven check of `_adv_is_loopback_bind` over all seven address forms `ss` emits.
- The empty-vs-unknown defect in §5 was found this way and fixed.

## Build notes — obstacles & lessons

Found by local harnesses and a pre-run review pass (2026-08-25); **nothing has run on a VPS.** Bulk commits: c40137a (profile lib), fd6879f (prompt helpers); `git log -S<symbol>` finds the exact line. Memory source: `project_host_optimization_083`. The pre-G7 text of this doc's testing and review narrative: `git log -- docs/reference/script083_design.md`, the commit before the G7 re-org (2026-10-13).

### Probes that lie

#### An empty string is not `unknown`, and the gap invents findings
**Symptom:** the advisor reported an atime finding about a filesystem it had never read. **Cause:** `cmd 2>/dev/null || echo unknown` fires only on a non-zero exit, but `awk`/`sed`/`grep -o` routinely succeed while printing nothing (a `df` mount point absent from `/proc/mounts`, a bind mount, a sysfs file with no bracketed selection); the empty result slipped past every `[[ "$v" != "$HP_UNKNOWN" ]]` guard and rendered as a measurement. **Fix:** every value-returning probe is piped through `_hp_out`, which normalises blank to `unknown`. **Lesson:** `|| echo unknown` guards the exit status, not the value.

#### `unknown` must never reach arithmetic
`(( unknown > 4 ))` is a bash syntax error, not a false. Every numeric comparison is gated by `adv_is_num` first. `ulimit -Sn` legitimately prints `unlimited`, which is not a number — the whole fd check vanished on those hosts until it was handled.

#### `grep -c … || echo 0` prints two lines
**Symptom:** the one host that deserved the "no security updates pending" OK line was the only host that never got it. **Cause:** `grep -c` prints `0` *and* exits 1, so the fallback emits `"0\n0"`, which fails `adv_is_num` and silently drops the finding it feeds — in `hp_pending_security_updates` the zero case is the fully patched box. **Fix:** swallow the status with `|| true` and normalise the value. **Lesson:** a check that disappears exactly when it passes is worse than no check.

#### Grade a listening socket by "is it loopback", never by "is it the wildcard"
**Symptom:** a node bound to one specific public IP was told "not directly reachable from the internet" — the opposite of the truth, on the most safety-critical check in the tool. **Cause:** the first cut tested `bind == 0.0.0.0:$port`; a specific public address matches no wildcard pattern and fell into the `else` branch. **Fix:** loopback is a short closed list (`_adv_is_loopback_bind`, tested over all seven address forms `ss` emits); assert the safe case and treat the remainder as exposed. Two corollaries: a port normally carries two listeners (v4 and v6), so read every row, never `head -1` — the safe one masks the exposed one; and `ss -tlnH` needs iproute2 ≥ 4.5, so use the repo's `ss -tln | tail -n +2` (on an older box `-H` exits non-zero printing nothing, which reads as "no listener" and reinstates the false-OFFLINE bug hub 08 had just fixed). **Lesson:** a closed safe-list beats an open danger-list.

#### Smaller probe fixes from the review pass
`PermitRootLogin forced-commands-only` and any unrecognised value produced no finding at all; three separate `sshd -T` calls that could disagree collapsed into one; `xargs` as a whitespace trimmer also does quote processing and errors on an unmatched quote, so `_hp_trim` replaced it; `${b#[}` silently does nothing (bash reads `[` as a bracket expression) and must be `${b#"["}`.

### Screens and prompts

#### A report that merely stops looks truncated
Every long read-only screen ends with an explicit `[END]` marker (`ui_end`) carrying the finding counts and "nothing was changed". `_page` measures the content against `tput lines` instead of leaving that to `less -F`, sets `UI_PAGED`, and the exit prompt mentions `q` only when the screen really went through the pager. The full report is paged through the house `less -FRX` because CRIT findings sort to the top and were the first thing to scroll away; `_wrap` reads `tput cols` because `COLUMNS` is unset in a non-interactive child. Menu rows covering two areas profiled the host twice and demanded two Enter presses — `show_single_area` is now variadic.

#### Backing out of a prompt confirmed the action
**Symptom:** the instinctive way to back out (Enter, or Ctrl+C) took the default and proceeded; the worst case was the self-update custom-branch prompt, where an empty Enter answered "Defaulting to 'main'" and armed an update from a branch the operator never chose. Ctrl+C kills the whole menu script rather than the prompt. **Fix:** `ui_ask` / `ui_ask_num` (in `scripts/lib/ui_shared_helpers.sh`) return non-zero when the operator types `q`, and the caller must return without acting; ten prompts in hub 08 were converted, `[y/N]` confirmations left alone (Enter already means "no"). Cancel is `q`, not `0` or Enter, because `0` is both a legal value and "back" in sub-menus and Enter already means "accept the default". **Lesson:** one key cannot mean both "proceed with the default" and "do nothing".

#### `printf -v "$name"` writes into the callee's own locals
**Symptom:** `ui_ask` returned rc 0 with an empty value. **Cause:** bash's dynamic scoping puts the callee's locals in scope, so a caller asking `ui_ask` to fill `_uia_ans` overwrote `ui_ask`'s own working variable. **Fix:** `_ui_name_ok` rejects a reserved prefix — and the guard takes the prefix as a *parameter*: a blanket "reject anything starting `_ui`" also refused the lib's own internal call (`ui_ask_num` asks `ui_ask` to fill `_uin_val`), which made every `ui_ask_num` in the toolkit return "cancelled" while looking correct on the page. **Lesson:** long unlikely names make a collision improbable, not impossible; both traps were caught by testing, not review.

### Menu

#### Two hub-08 keys changed hands; no alias
Folding SSH into 083 freed key `5` (`3` = 083, was Node Status; `5` = Node Status & Sync, was SSH). A reassigned key gets no alias `case` arm — bash takes the first match, so an alias would silently open the wrong product; the per-screen banner is the mis-key safety net. SSH is a navigation merge, not a code merge: 085 still owns every SSH change. (Key `6` later became 086 and Top 20 Bandwidth moved into 084 option `5`.)

#### Errexit is off inside both libs
Both libs are sourced into a script whose dispatch is `fn || true`, which disables errexit for the entire callee body; nothing in either lib relies on `set -e`. The same holds for `08_lib_host_updates.sh`, and its snippets run with `set -u` only, so every write, move and delete carries its own check.

### Automatic Security Updates

#### A higher-numbered apt.conf.d file cannot narrow a list
**Symptom:** a drop-in listing only security origins would still have allowed every origin in the stock `50unattended-upgrades` (Ubuntu's release pocket). **Cause:** apt config lists append across files; `apt-config dump` shows both sets merged. **Fix:** the drop-in opens with `#clear Unattended-Upgrade::Allowed-Origins;` and `#clear Unattended-Upgrade::Origins-Pattern;`, and enable/status read the effective list back so a file numbered above 52 that widens it is flagged. **Lesson:** check an apt list option with `apt-config dump`, never by reading the one file you wrote.

#### A read-back that only warns still reports success
**Symptom:** a `60` file with `Origins-Pattern {"origin=*"}` and `Automatic-Reboot "true"` let enable print `__OK__` — 081 would have counted an all-origins, self-rebooting host as patched safely. **Cause:** the effective-config read-back printed `WARN:` and carried on; the classifier also matched anything *containing* "security". **Fix:** read-back mismatches are `ERROR` + exit 1 with no `__OK__`, classification is exact-match, and run-now repeats the check before touching packages. **Lesson:** in a script whose success is a sentinel line, a check that cannot stop the sentinel is decoration.

#### `systemctl is-enabled` has more answers than enabled/disabled
systemd 255 prints `not-found` for a missing unit; a "not disabled/masked ⇒ on" test read it as scheduled. On-states are now a closed list (`enabled`, `enabled-runtime`, `static`, `alias`, `generated`), everything else is off — the same closed-safe-list rule as the loopback check above.

#### A temp file in apt.conf.d is config
apt parses every extension-less file in `apt.conf.d`, so a `name.tmp.$$` written there for an atomic `mv` is briefly live config (and draws a notice). Temps are named `*.bak`, which apt ignores silently (`Dir::Ignore-Files-Silently`).

## Open items

1. **Run it on a real VPS.** Nothing here is validated against a live node.
2. Further per-item apply paths with recorded before-values, once (1) confirms the advice. Automatic Security Updates is the only one, because it cannot touch firewall, SSH or network state; anything that can (`ufw enable` before an SSH allow-rule leaves a box reachable only from the provider's console) waits for (1).
3. Optional IO benchmark (off by default, disruptive on a live node) — deliberately omitted rather than shipped as a default.
4. Feed the profiler back into Script 01 so its swap and `peer_max_inbound_count` are sized rather than hardcoded. Deferred by the user: Script 01 works and is not to be touched yet.
5. **Automatic Security Updates on a VPS** — owed before it is trusted: a real enable → `unattended-upgrade --dry-run -d` on Ubuntu 24.04 and Debian 12/13; the NodeSource `site=` pattern actually selecting `nodejs`; Rocky/Alma 10 `dnf-automatic` with `reboot = never`, `check-upgrade --security -C` and the `needs-restarting` text parsing (dnf 4 and dnf 5 wording); needrestart's batch output on a box with stale services; a masked apt timer failing enable; `apt-get -d` then install from the archive, and dnf `--downloadonly` then `install -C` actually reusing the download; the detached run (083 locally and 081 remotely) surviving a dropped ssh session mid-dpkg. The detached launcher: `systemd-run --collect -p IgnoreSIGPIPE=no` as root on each distro (only the `setsid` fallback and a stand-in ran locally — confirm `cmd | head` inside a real unit exits 141), `flock` on each distro, `sudo -n bash -s` for a non-root ssh user, and status timing on a larger fleet (servers are read one after another; needrestart and dnf probes can take up to a minute each).
6. The report's dnf branch of `hp_unattended_ok` reads only `/etc/dnf/automatic.conf`, so a dnf 5 host relying on the `/usr/share` defaults with `upgrade_type = security` set there would still WARN.
7. **setsid fallback with a non-root ssh user.** Through `sudo -n` the fallback child stays in that user's logind session; with `KillUserProcesses=yes` in `logind.conf`, logind kills it when the ssh session closes. systemd-run (the normal path on every supported distro) is unaffected; the fallback is used only without a running systemd or when systemd-run refuses.
