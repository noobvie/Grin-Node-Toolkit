# Script 03 — Chain-Data Snapshot Method: implementation

> **Covers code as of:** 2026-08-22 · **Last verified:** never systematically verified
> **Product code last changed:** 2026-08-24 — `scripts/03_grin_share_chain_data.sh`, `scripts/lib/03_lib_remote.sh`
> **Scope:** what the publish pipeline and the remote copy do as built, plus the Build notes. The problem statement, the ordering rule, the 03↔01 contract, the phases and the rsync proposal are `script03_design.md`.

**Status:** phases 1–4 and the remote copy (option C) are **implemented, not VPS-tested**. Phase 5 (object storage) is **dropped** (decision 2026-08-18): stay on VPS free space.

## What shipped

### Publish pipeline (phases 1–4)

**Compress, cadence and presets.** `bash -n` clean on both scripts. Helper logic and cadence
arithmetic verified locally with one-shot tests (no lingering processes).

`scripts/01_build_new_grin_node.sh`
- Added `_max_age_for_site_key` beside `_get_site_key`; `download_chain_data` now
  derives `_MAX_AGE_DAYS` from it instead of the hardcoded 5.
- Incidental fix: the "Checking zone hosts" line said **≤ 7 days** while the constant
  was 5. It now interpolates the real value.

`scripts/03_grin_share_chain_data.sh`
- Added `COMPRESS_LEVEL_FULL` / `COMPRESS_LEVEL_PRUNED` (env-overridable).
- `compress_chain_data`: `tar -czf` → `tar -cf - | pigz -p $(nproc)` with `nice -n 19`
  + `ionice -c 3`, gzip fallback, `PIPESTATUS` check, and partial-archive cleanup.
- Added `_node_type_for_network`; `get_cron_expression` / `list_presets` take a node
  type and branch the preset set.
- Incidental fix: `cd "$OUTPUT_DIR" && sha256sum …` was an unguarded `&&`. With no
  errexit in this script a failed `cd` would have skipped the checksum silently and
  left step 7 publishing a manifest naming a `checksum_file` that does not exist.

**Verified locally:** a failing tar in the pipeline reports `tar=2 compressor=0` — the
precise case where the old single-command `$?` test read 0 and would have published a
truncated archive beside a valid `.sha256` and a valid manifest. The `PIPESTATUS` check
catches it and removes the partial. Round-trip extract diffs clean against source and
`sha256sum -c` passes.

**Disk preflight, retained set and atomic swap.** `bash -n` clean across every script and lib. Verified with a
30-assertion isolated harness (functions extracted, no script execution, no servers, no
network, temp dir removed).

`scripts/03_grin_share_chain_data.sh`
- Added `COMPRESS_RATIO_FULL` / `COMPRESS_RATIO_PRUNED` / `DISK_HEADROOM_MB`
  (env-overridable) and the `RETAIN_PREVIOUS` run flag, reset per instance.
- Added `preflight_disk_space()` as step 0a, wired ahead of `clean_output_directory`.
- `clean_output_directory` honours `RETAIN_PREVIOUS`; debris patterns moved into an array
  and now include step 5's hidden work files (a bare `*` never matches a leading dot).
- `compress_chain_data` builds to `.<base>.tar.gz.tmp`, hashes it, writes the checksum
  with the **final** name, then swaps: manifest → old archive/checksum → `mv` → `chmod 644`.
- `create_status_in_progress` gained the retained-set branch, worded to keep the
  `Sync completed.` gate intact (see phase 4 above).

**Verified locally (30/30):** preflight picks all three branches correctly and a forced
abort leaves archive *and* manifest byte-untouched; retain-mode clean keeps the published
set and `index.html` while still sweeping hidden temps and debris; the swap leaves exactly
one visible `.tar.gz`, no hidden temp, `sha256sum -c` verifying, the final name in the
checksum line, `lock.mdb` excluded, and the tar readable; **a failed compress leaves the
previous archive byte-identical and its manifest still published.** The status note carries
`Sync completed.` and neither "in progress" nor "DO NOT download", on one line.


### Reducing load during compression

With phase 5 dropped, everything has to come from the local box. Implemented:

| lever | effect |
|---|---|
| **`nice`/`ionice` now wrap `tar`, not just the compressor** | this was backwards. tar is the process reading the whole ~20 GB off disk, so it is the one whose IO needed deprioritising; the compressor is CPU-bound and reads from a pipe |
| **`nocache` on the read side** | the cost that never shows in `top`: streaming 20 GB through tar evicts nearly everything else the box had cached, so nginx/wallet/pool run cold for a long time afterwards. `nocache` drops those pages as it goes. Optional package, no-op when absent |
| **honest `ionice` logging** | `ionice` is honoured by **CFQ/BFQ only**. Modern kernels default to `mq-deadline` or `none` for virtio-blk and NVMe — i.e. essentially every VPS — where it is accepted and silently ignored. `_io_scheduler` reads `/sys/block/<dev>/queue/scheduler` and the log now says whether the throttle is real |
| **`COMPRESS_THREADS`** | caps pigz's thread count so cores stay free for the services still serving. Independent of level — fewer threads changes load, not output |

`nocache` wraps **tar only**, deliberately: the compressor writes to a shell redirect it
never opens itself, so an `LD_PRELOAD` shim cannot see that fd. And the pipeline must stay
**two elements** — the `PIPESTATUS` check indexes 0 and 1, so slipping in a third stage
(`| nocache dd of=…`, say) would silently stop checking one of them.

### Remote copy follow-ups

Everything left in §14.1 and §15 that does not require the VPS is now built.

#### 17.1 Failure notification — `lib/grin_alerts.sh`

An unattended fortnightly job that fails leaves a mirror stale for a fortnight,
and the only evidence is a log nobody opens.

The obvious implementation is to call into Script 082, which already knows how
to reach the operator. **That is the wrong move**: 082 deliberately compiles a
*self-contained* worker to `/opt/grin/access-watch.sh` so a tamper alert never
depends on the rest of the toolkit still being intact. Making it source a lib
would undo the one property it is built for.

So the new lib duplicates the delivery code and shares **the thing that actually
matters — the same `alert.conf`**. Channels are configured once, in 082's menu,
and any product that sources the lib can reach them. The cost is stated in the
lib header: a channel added to 082 will not appear here on its own.

Behaviour worth knowing:

- **Driven off the per-target state files**, not off this run's results — so a
  mirror that failed two runs ago and was skipped this time is still counted.
  A run-scoped summary would quietly omit it.
- **Standing failures do not re-alert.** The failure set is hashed; a new or
  changed failure speaks, an unchanged one stays quiet. Same rule 082 uses.
- **Recovery gets exactly one message**, and only to someone who was told about
  the failure.
- **An undeliverable alert does not record the hash** — otherwise the first
  failed delivery would silence every repeat of that failure.
- `last_result=running` is reported as a failure: it means a run died without
  reaching either branch (kill, reboot, OOM), which is a failure that never got
  to say so.
- The menu path sets `RC_NOTIFY=false`. Alerting an operator about something
  they just watched fail on screen trains them to ignore the channel.

A test that loaded two different confs in one shell caught a real bug here:
`set -a; . conf` **exports** every key, so a channel removed from the conf kept
resolving from the previous load — CLAUDE.md's documented `source` trap. The
keys are now unset before each load.

#### 17.2 `--delete` allow-list

`--exclude` protects the files we thought to name and nothing else. rsync filter
rules are first-match-wins, and `R` (risk) marks a file deletable while `P`
(protect) exempts it, so:

```
--filter='R *.tar.gz' --filter='R *.sha256' --filter='P *'
```

inverts the default: `--delete` can remove a superseded archive and its
checksum, and **literally nothing else**. Together with the path rule from
§16.4, a wrong `remote_dir` is now a misfiling rather than an erasure.

#### 17.3 `pigz --rsyncable` (§14.1 D)

Enabled when present, on both pigz and gzip. It resets the compressor at
content-defined boundaries, so one changed block near the start of the stream
does not shift every byte after it — without it rsync ships all ~18 GB again on
every build.

This matters *because the copy goes over ssh*: rsync's delta transfer is on by
default there, and only local→local implies `--whole-file`. chain_data grows
mostly by append, so most of the archive genuinely is unchanged between builds.
Costs a few % ratio, which at level 1 is noise.

**Probed, never assumed.** It is a build-time option missing from some distro
pigz builds, and an unknown flag makes pigz exit non-zero — which would fail the
whole pipeline rather than degrade.

#### 17.4 `ensure_package` no longer retries for ever (§14.1 E)

When a package genuinely is not available — `nocache` is in no RHEL base repo —
the old version ran a full `apt-get update` plus a failing install on **every
cron run, for ever**: minutes of network and disk on a box this redesign exists
to keep quiet, to reach last run's answer.

A failure now writes a marker and is not retried for `PKG_RETRY_HOURS` (24).
Only *failure* is cached, and only for a while, so a package that appears in a
repo later is still picked up. An installer that exits 0 without producing the
command counts as a failure — what the caller needs is the binary.

#### 17.5 Compression benchmark — menu key `J` (§14.1 B and C)

`COMPRESS_LEVEL_FULL=1` was chosen from how Bulletproof rangeproofs behave in
general, not from a measurement. Settling it properly means compressing the same
bytes at several levels, and a full run is ~30 min with the node stopped — so
nobody does it twice and the question stays open.

Key `J` samples instead: it takes the largest files in chain_data (the PMMR data
files, which dominate both the size and the ratio), compresses a few hundred MB
of them at 0/1/3/6/9, and prints ratio, seconds, MB/s and a projected archive
size. **The node keeps running** — this only reads. A warm-up pass runs first,
or the first level would pay for the disk read and every later one would read
from page cache, making level 0 look slowest.

It also prints `du` vs `du --apparent-size`, which answers §14.1 C directly:
apparent > allocated means the files are sparse and `tar --sparse` has something
to save; equal means it has nothing to save, so its Windows-bsdtar
incompatibility buys us nothing and the question is closed.

Finally it times `--rsyncable` at the shipped level, so the mirror discount has
a measured price rather than an assumed one.

**§14.1 B was already half-closed** and this was missed in the earlier summary:
`preflight_disk_space` self-calibrates, preferring a ratio measured from the
published archive over the `COMPRESS_RATIO_*` constant. What was actually open
was the *level* choice, which is what `J` answers.

## Runbook

### Acceptance run (owed — nothing built since 2026-08-17 has executed on a real server)
Run `--cron-nginx` on **testnet first**. Watch step 0a's numbers against reality; confirm the publish swap; confirm `chmod 644` on the published files (untestable locally — Git-bash fakes POSIX modes); confirm the node restarts after a *deliberately* failed compress; then the remote copy (real transfer, key auth, identity probe, `flock`). Every failure mode these phases address is a runtime one, so nothing else should ship before this has run once.

### Measuring the compression level
Menu key **J** samples the largest `chain_data` files at levels 0/1/3/6/9 with the node still running (read-only, after a warm-up pass) and prints ratio, seconds, MB/s, a projected archive size, `du` vs `du --apparent-size` (sparse-file check for `tar --sparse`) and the `--rsyncable` cost. `COMPRESS_LEVEL_FULL` is an env var, so a result changes no code.

## Build notes — obstacles & lessons

Phases 1–4 landed in 7f642d7 (2026-08-18); the remote copy, alert lib and follow-ups in 6451408 (2026-08-22). The pre-G7 text of the implementation log and the three review passes: `git log -- docs/reference/script03_design.md`, the commit before the G7 re-org (2026-10-13). **None of this has run on a VPS.**

### Publish pipeline

#### A failed compress left the grin node stopped indefinitely
**Symptom:** after any failure in step 5 the node stayed down until a human noticed — on an unattended biweekly mirror, up to a fortnight. **Cause:** step 1 stops the node and every failure path called `error_exit` (`exit 1`), so step 9 never ran. **Fix:** every failure path in `compress_chain_data` returns 1 and the pipeline brackets steps 5–8 so `restart_grin_node` runs on both paths; with retention, a failed run now costs nothing — node back up, previous archive still served, next run retries. **Lesson:** a stop/start pair is a `finally`, not two steps.

#### A disk shortage on one network killed the other
**Cause:** `error_exit` is `exit 1` and `run_cron_nginx` runs mainnet then testnet in one process, so step 0a aborting on fullmain would have taken a healthy prunetest publish down with it. **Fix:** `preflight_disk_space || return 1`; nothing is stopped or deleted at that point, so returning is clean. **Lesson:** `exit` inside a function that a multi-instance loop calls is a cross-instance kill switch.

#### The partial archive was fetchable by exact name
**Cause:** nginx autoindex omits dotfiles from the *listing* (which hides the temp file from Script 01's href grep) but still *serves* a dotfile requested by exact name, and `.grin_full_mainnet_<date>.tar.gz.tmp` is predictable. **Fix:** both work files are created mode 600 inside a `( umask 077; … )` subshell before anything writes to them, and the swap re-opens them to 644 — in the producer, so it also holds on third-party mirrors we do not configure. **Lesson:** "hidden from the listing" is not "not served".

#### A failing `tar` in a pipeline published a truncated archive
**Cause:** the old single-command `$?` test read the compressor's status, so a failing tar beside a valid `.sha256` and manifest looked fine. **Fix:** `tar -cf - | pigz` with a `PIPESTATUS` check and partial-archive cleanup; the pipeline must stay **two elements** because the check indexes 0 and 1 — a third stage (`| nocache dd of=…`) would silently stop checking one of them, and `error_exit` must stay `exit` for the guard clauses to work (a harness stub that returned instead made two tests fall through into the swap). **Lesson:** verify a pipeline by failing each stage.

#### `gzip -0` is rejected, and the level is env-overridable
**Symptom (avoided):** `COMPRESS_LEVEL_FULL=0` — attractive for near-incompressible data — would build on a pigz box and hard-fail at step 5 on its gzip-fallback twin with the node already stopped. **Fix:** `_clamp_level` floors at 0 for pigz and 1 for gzip, caps at 9, and falls back to 6 on anything non-numeric (which would otherwise reach the compressor as a flag).

#### Smaller publish-side fixes
An unguarded `cd "$OUTPUT_DIR" && sha256sum …` would, with no errexit in the script, skip the checksum silently and publish a manifest naming a checksum file that does not exist. Debris patterns now include step 5's hidden work files (a bare `*` never matches a leading dot). The "Checking zone hosts" line said ≤ 7 days while the constant was 5; it now interpolates the value. `ionice` is honoured by CFQ/BFQ only — modern virtio-blk/NVMe default to `mq-deadline` or `none`, where it is accepted and silently ignored, so the log now says whether the throttle is real; `nice`/`ionice` were wrapping the compressor when `tar` is the process reading ~20 GB off disk; `nocache` wraps tar only because the compressor writes to a redirect an `LD_PRELOAD` shim cannot see.

### Remote copy (option C)

#### The schedule parser never matched, and ten green tests said it did
**Symptom:** menu option 5 failed every time with "Could not derive a schedule from the build cron". **Cause:** the nginx installer writes one cron line with the marker appended at the end (`… # grin-node-toolkit: grin_share_nginx_main`); `_rc_derive_schedule` looked for the marker on a line of its own and took the next line (`grep -A1 -x -F`) — a layout the script never wrote. The first harness built its fixture in that same imagined two-line format, so it exercised the code against the assumption. **Fix:** the end-of-line anchor the installer already uses (`grep -E 'grin_share_nginx[[:space:]]*$'` — a plain `-F` returns the testnet line when asked about mainnet because the legacy marker is a prefix); the harness now lifts the format out of the installer's own `cron_line="…"` assignment and `eval`s it. **Lesson:** a test that cannot observe the thing you are checking is not evidence — derive fixtures from the producer.

#### The producer never took the lock
**Cause:** the lib documented mutual exclusion with the nginx pipeline, but `grep -n flock scripts/03_*.sh` found nothing; the window was real — preflight verifies archive N, a build starts, and the swap deletes the manifest and archive while rsync is still reading them. **Fix:** an asymmetric lock — the copy holds it for its whole run (it is the reader); the build takes it only around the publish swap (seconds), not around ~30 min of compression, which writes `.tmp` files no reader looks at; the build waits a bounded 30 min and then swaps anyway rather than stall behind a stuck upload, and `rc_push_target` re-reads `generated_utc` after its transfer and aborts rather than publish a set spanning two builds. The copy waits 60 s for the lock (a build holds it for seconds; a running copy for hours, which 60 s cannot outlast, so that case still gives up fast).

#### A failed copy took a healthy mirror out of rotation
**Symptom:** one network blip = up to 14 days of a working mirror unused. **Cause:** the remote manifest was removed and a "DO NOT download" note written *before* rsync and never restored on failure; Script 01's discovery greps for `Sync completed.` and skipped the mirror. **Fix:** the same rule `RETAIN_PREVIOUS` gives the local set — the manifest is stashed to `.chaindata.json.prev` (a dotfile, so `--exclude='.*'` shields it from `--delete`), and every failure path restores it with a status note that still says `Sync completed.` and explains it is the previous build; `_rc_restore_remote` runs only when a stash was actually taken (restoring over a dead ssh connection cost a second `ConnectTimeout` per unreachable mirror).

#### `--delete` could erase more than a superseded archive
**Fix:** rsync filters are first-match-wins and `R` (risk) marks a file deletable while `P` (protect) exempts it, so `--filter='R *.tar.gz' --filter='R *.sha256' --filter='P *'` lets `--delete` remove a superseded archive and its checksum and nothing else; with the `remote_dir` rule below, a wrong path is a misfiling, not an erasure. The remote dir must end in `/<site_key>` (it accepted `/var/www`, `/srv`, `/usr/share/nginx/html`), host and path metacharacters, whitespace and a leading `-` are rejected (`/var/www/x';id;'` and `-oProxyCommand=…` were both accepted), and `enabled` must be `true`/`false` (`yes` silently meant disabled). Remote `chown www-data:www-data` was dropped (absent on RHEL mirrors; `rsync -a` preserves 644, which is what nginx needs).

#### Smaller ones worth keeping
`RC_SCHED_WARN` was set inside `$(…)` — a subshell — so the reason for a refusal was always discarded (the function now returns via globals and is called directly). "Copy now" trusted our own state file, so a wiped mirror was skipped as "current" (it now confirms `generated_utc` on the mirror). Enable/disable was remove-then-add, so a write failure between them deleted the mirror (now an in-place rewrite). `remove_nginx_schedule` greps `grin_share_nginx`, which by design misses `grin_share_remote`, so there was no way to remove a copy schedule. Rescheduling stacked a second cron entry (de-duplication removed the exact line it was about to write; the survivor was untagged and invisible — now filtered on `--cron-remote <site_key>`). `rc_target_remove` returned 0 for a mirror that did not exist, and an empty site_key matched on the alias alone and deleted nothing. A `--rsyncable` benchmark row read `$NODE_TYPE`, unset when the menu is reached. A numbered picker (`_rc_pick_target`) replaced typed `site_key` prompts, which removed that whole class of typo.

#### Checksum gates are off by default (operator decision)
`RC_VERIFY_LOCAL` / `RC_VERIFY_REMOTE` default to false: reading a 17–20 GB archive twice more is the IO this redesign exists to remove, and rsync already checksums what it transfers and exits non-zero on a mismatch. **Given up, stated plainly:** a source archive already corrupt on disk is fanned out to every mirror and nothing proves what sits on a mirror afterwards; the `.sha256` ships so downloaders verify for themselves. The copy screen claimed verification that no longer happens until it was corrected — a screen claiming a gate nobody runs is worse than no screen.

### Alerts and secrets

#### `set -a; . conf` put secrets in every child's environment
Review of the alert lib (17.1, What shipped) found it still sourced `alert.conf` under `set -a`, copying 082. 082 needs the export to hand values to a compiled worker; here they are only read in-process, so the Telegram bot token and the nostr secret key were exported into the environment of every child (tar, pigz, ssh, rsync) for no gain. Dropped. **Lesson:** do not copy a flag from the code you copied unless you share its reason.

### Benchmark traps

A warm-up pass runs first, or level 0 would look slowest because it paid for the disk read. The benchmark pick-list read `${k}_CHAIN_DATA` from the nginx conf, which holds the *output* dirs (`LOCAL_WEB_DIR_*`); the paths live in `$INSTANCES_CONF`, so every run fell through to "type a path", which read as a design choice rather than the bug it was. The sparseness report tested `"${real_kb}${app_kb}"` as one string, so one failing `du` left numeric-looking digits and printed `[: : integer expression expected` mid-table. `COMPRESS_LEVEL_FULL=1` is reasoned, not measured: `preflight_disk_space` self-calibrates from the published archive's ratio, and what stays open is the *level*, which key `J` answers.

### Test methodology

#### Pipe into a function and its globals vanish
Two picker tests failed on first run because the harness piped stdin into `_rc_pick_target`, putting it in a subshell and discarding the globals it sets — the test's fault, not the code's, but the same shape is a trap anywhere the pattern is reused. The harnesses lift real functions out of the script with `awk` and drive them rather than restating what they are believed to do.

## Open items

- **The acceptance run** (Runbook) — the one blocker for everything else.
- **Still needs the VPS, and only the VPS:** `flock` (Git-bash has none, so the lock only runs its degrade-to-no-op branch locally); rsync filter semantics (documented behaviour, not observed); real transfers, key auth and the identity probe; the benchmark's real numbers.
- **Measurements still open** (`script03_design.md` §4 and §10): 0a (the level choice, key `J`), 0b (is prunemain or fullmain the bandwidth cost), 0c (does a beyond-horizon pruned node discard the snapshot).
- **Known limit, not fixed:** if the *build* never runs, `rc_preflight_local` refuses and no per-target state is written, so `rc_notify_summary` stays silent — a month of failed builds leaves every mirror stale with no alert from the copy side. Arguably correct division of labour (the build cron owns its own failure surface); flagged rather than built.
- **Phase 5 (object storage) is dropped** (decision 2026-08-18): stay on VPS free space.
- **`tar --sparse`** is not shipped: it emits GNU sparse entries and Script 01's documented extraction uses Windows bsdtar; it would be a client-breaking change needing a Windows extraction test.
