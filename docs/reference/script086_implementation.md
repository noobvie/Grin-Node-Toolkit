# Script 086 — Diagnostics & Support Bundle (Implementation)

> **Covers code as of:** 2026-10-27 — §9 (public status page), written against the uncommitted working tree after its build and reviews; 2026-10-03 — §8, written against the uncommitted working tree that
> holds the node event recorder (the recorder and its post-build fixes). §8.15–§8.19 were written by the
> sessions that built each part and moved here unchanged from `script086_design.md` on 2026-10-03;
> the file map, §8.20 and §8.21 were read against the code on that day ·
> **Last verified:** §9 never verified against a run (test results are described in §9.7); 2026-10-03, PARTIAL — §8 only. The post-build review (§8.19) checked the read-only gate
> by grep, the transitions and the debounce with a local harness over the pure functions, and the
> launch command through stubbed `su`/`tmux`/`grin`. The docs-fold session re-read the file map,
> §8.20 and §8.21 against the libs (function names, paths, unit and logrotate text, the order of
> `gne_classify`'s rules). **Nothing has been installed or run on a VPS** ·
> **Product code last changed:** 2026-10-27 — the §9 public status page (uncommitted): `scripts/lib/grin_node_public.sh`, `grin_node_public_compact.sh`, `grin_node_public_run.sh` (new), `grin_node_events.sh`, `scripts/086_grin_diagnostics.sh`, `089_backup_restore.sh`, `08del_clean_all_grin_things.sh`, `web/04_node_api/`, `web/06d_tiny_explorer/`; 2026-10-03 — `scripts/lib/grin_node_events.sh`,
> `scripts/lib/086_lib_recorder.sh`, `scripts/lib/grin_alert_send.sh`,
> `scripts/lib/grin_log_signatures.sh` (all new), `scripts/lib/grin_node_control.sh`,
> `scripts/lib/grin_node_keepalive.sh`, `scripts/lib/086_lib_diag.sh`, `scripts/086_grin_diagnostics.sh`,
> `scripts/082_provider_access_watch.sh`, `scripts/01_build_new_grin_node.sh`,
> `scripts/03_grin_share_chain_data.sh`, `scripts/07_grin_mining_solo.sh`, `scripts/081_host_monitor_port.sh`,
> `scripts/08del_clean_all_grin_things.sh`, `scripts/089_backup_restore.sh` (uncommitted)

**Status:** built, reviewed locally, **never run on a VPS** (acceptance and open items: §8.22; the public status page §9: §9.8).

The design is [`script086_design.md`](script086_design.md). Keys 1–6 (health check, support bundle,
API performance, log triage, consumer load test, saved reports) have no separate as-built record:
their design doc §1–7 was written with the code on 2026-09-25 and doubles as one. This file holds
the as-built record of the **node event recorder** (key 7).

**The section numbers continue the design's §8.** The design's §8.1–§8.14 are the recorder's
design; §8.15 onward are here. Code comments that say "086 §8.15" or "086 §8.18" therefore resolve
to this file, and the design keeps a pointer under the same numbers.

## What shipped

### 8. Node event recorder — as built

Every part below was built and reviewed locally. **None of it has run on a VPS.** Acceptance
(§8.22) is testnet first, then mainnet.

**Where it lives.**

| File | Role |
|---|---|
| `scripts/lib/grin_node_events.sh` (`gne_*`) | The recorder: config loader, `gne_decide` (the §8.4 state machine as one pure function), the per-net check, ledger and `status.json` writers, evidence capture, `gne_classify`, alert decision + debounce, the generated worker, units, logrotate, `gne_install` / `gne_remove` / `gne_status`, and the `recorder.conf` setters 086's menu uses |
| `scripts/lib/grin_alert_send.sh` (`gas_*`) | Off-box delivery (ntfy, Telegram, email, Nostr), extracted from 082. The recorder sources its `/opt/grin/lib/` copy; 082 inlines it into its own worker (§8.17) |
| `scripts/lib/grin_log_signatures.sh` | 086's `DG_SIG_*` signature table, moved out of `086_lib_diag.sh` byte-identical. The recorder uses it only for `summary.txt`'s signature counts |
| `scripts/lib/086_lib_recorder.sh` (`dgr_*`) | 086 key 7's read side: ledger parse, timeline, the availability sweep, bundle list, masking, export, the support-bundle section |
| `scripts/086_grin_diagnostics.sh` (`rec_*`) | Key 7's screens, and support-bundle file `10_recorder.txt` |
| `scripts/lib/grin_node_control.sh` | The launch-contract side (§8.20): `_gnc_node_run_cmd`, `gnc_mark_planned_stop` / `gnc_mark_all_planned_stops`, `gnc_grin_pids_for_dir` |
| `scripts/lib/grin_node_keepalive.sh` | The watchdog hook in the generated `do_restart()`, and `gnk_autostart_enable` building its `@reboot` line from `_gnc_node_run_cmd` |
| Scripts 01, 03, 07 solo, 081, 08del | Stop paths that SIGTERM by port now write the marker first; 03 → G's `@reboot` line uses the shared pane command |
| Scripts 01, 08del, 089 | Lifecycle: install offer / Super Auto, STEP 3c removal, ledger backup (§8.18) |

**Installed footprint** (`gne_install`; re-running it is how a box picks up a toolkit update):

```
/usr/local/bin/grin-node-events                 0750  check | capture <net> <watchdog_restart|manual> [reason] | show [net] | test-alert
/etc/systemd/system/grin-node-events.service    Type=oneshot, ExecStart=… check, Nice=10, IO best-effort/7, TimeoutStartSec=120
/etc/systemd/system/grin-node-events.timer      OnBootSec=60s, OnUnitActiveSec=30s, AccuracySec=1s
/etc/logrotate.d/grin-node-events               */ledger.jsonl: size 10M, rotate 12, nocopytruncate, create 0644 root root, compress + delaycompress
/opt/grin/lib/{grin_node_control,grin_node_events,grin_log_signatures,grin_alert_send}.sh   0644 copies the worker sources
/opt/grin/lib/{grin_node_public,grin_node_public_compact,grin_node_public_run,086_lib_recorder}.sh   0644 public status page (§9.1)
/opt/grin/conf/node-events/recorder.conf        0600  written only when absent
/opt/grin/node-events/                          0755  creating it is what turns the planned-stop markers on
  <net>/  0755 (only for nets in the instances conf)   <net>/evidence/  0700
```

- `delaycompress` keeps `ledger.jsonl.1` plain, which is the one rotated file the pool's ingest
  finishes (07 implementation §10.15).
- `gne_remove` removes the worker, both units, the logrotate stanza, three recorder lib copies and the four public-status libs (§9.1), and takes the two served public files down (§9.6). It leaves the
  `grin_node_control.sh` copy in place, and keeps the state, the evidence and the conf. 08del
  removes those, asking about evidence first.
- Schemas are as in design §8.8, with the extra flat `status.json` keys listed in §8.15 and §8.16.

### 8.15 Recorder core as built

The recorder core lives in `scripts/lib/grin_node_events.sh`: `gne_decide` (§8.4 as one pure
function), the per-net check, the ledger and `status.json` writers, the config loader, the worker
(`check` / `capture` stub / `show`), the timer and the logrotate stanza. Where it differs from the
sections above:

- **More lines can close an outage.** `duration_s` and `outage_id` sit on whichever line closes
  the open outage: `up` and `boot` as designed, and also `auth_fail` (the node answered, so it is
  up), `unregistered` (observation ends) and `stop`.
- **A toolkit stop of a `down` node ends the outage.** If the pid goes away under a valid marker
  while the node is `down`, the result is a `stop` line that carries the duration, then state
  `stopped`. A toolkit *restart* of a down node (new pid) keeps the outage open until rule 3, as
  designed.
- **A restart between two checks is recorded, not counted.** If the API is `ok` but the pid
  changed since the last check, the check writes a `start` line (`by` = marker / watchdog /
  `unknown`). That is below the 2-strike resolution.
- **First sight of a node that is not running is `stopped`,** not an outage: the recorder cannot
  know why it is down.
- **A net that is neither registered nor ever observed writes nothing.** A mainnet-only box gets
  no `testnet/` dir.
- **`failed_start` subs** are `timeout`, `exited_rc=<n>` or `exited`. The sub charset has no space,
  so this is not the `exited rc=<n>` of §8.6.
- **An outage that spans a `gap` keeps wall-clock `duration_s`.** the availability maths must
  subtract `gap` intervals that overlap an outage.
- **`status.json` is one line**, with extra keys beside §8.8's: `sub_state`, `last_pid`,
  `grin_version_key`, `start_ref`, `last_outage_end`, flat copies of the open outage
  (`outage_id`, `outage_started_at`, `outage_class`), `pending_restart_ts` and
  `last_id_ts`/`last_id_seq` (the per-second `seq` of ledger ids, which survives a capture writing
  in the same second). `open_outage` is written last. The worker parses only the flat keys.
- **The worker sources `/opt/grin/lib/grin_node_control.sh` and `grin_node_events.sh`,** both copied
  there by `gne_install`. Re-running the install is how a box picks up a toolkit update.
  `gne_install` creates `/opt/grin/node-events/` 0755, which turns on the planned-stop markers.
- **`capture` is a stub** that exits 0, so the watchdog hook can never fail a restart.
  (Filled in; see §8.16.)

### 8.16 Evidence capture, classification and the watchdog hook

Evidence capture, classification and the watchdog hook. The signature table
(`DG_SIG_*`) moved from `086_lib_diag.sh` to `lib/grin_log_signatures.sh`. Its four arrays
are byte-identical (`declare -p` was compared before and after), so 086's output does not
change. The recorder uses that table only for the "signature counts" section of
`summary.txt`. Its class refinement is `gne_classify`, a separate table, because a class needs
a scope (start window, kernel log, live pid) that a per-line origin does not. Where the build
differs from §8.6 and §8.9:

- **The watchdog's capture can OPEN an outage.** The watchdog acts on ONE failed probe every
  5 min. The recorder needs two 30 s strikes, so the watchdog can restart a node the recorder
  still calls `up`. Under rule 7 that restart would count as a planned start, and a restart
  loop the watchdog catches early would read as 100 % available. So when the recorder's state
  is `up`, `capture … watchdog_restart` writes a `down` line and then
  `restart_by_watchdog`. `started_at` is `first_fail_ts`, or now. The class is:
  - `wedged` / `tip_stalled` for a `wedged:` reason;
  - `hung` / `bad_reply` for `no tip.height`;
  - `hung` / `watchdog_probe` when the pid is still alive;
  - otherwise the exit class from `.grin_last_exit`.

  In `starting`, `stopped`, `auth_fail` and `unknown` the capture opens nothing: a watchdog
  restart of a node that never came up is not a new outage. In `down` it continues the open
  outage.
- **The capture path writes the ledger and status BEFORE the evidence.** The watchdog gives
  it 20 s. A timeout can then lose evidence, but never the event. The bundle dir is created
  first, so both lines can name it. Because of that order, a class refined by that bundle
  arrives as a separate `reclass` line. The check path is not under that budget: it captures
  before writing, so its `down` line carries the refined `class` next to `class_initial`, and
  the bundle dir is renamed to the refined class.
- **`reclass` rules.** A reclass to `corrupted` is always written. A reclass to any other
  class is written only for an outage that this capture opened, where the watchdog's guess was
  the only class it had. A crashed outage that later shows `verify failed` after a restart
  becomes `corrupted`. A hung outage never silently becomes something else.
- **Start window.** Generic chain words and LMDB errors mean `corrupted` only when the run
  being judged never answered `get_status`. That covers a `failed_start`, a capture in
  `starting`, a capture during `restarting`, or a capture of a `failed_start` outage. They are
  read only from `start.txt` (lines from the LAST `Starting server` on, at most 3000) and the
  pane. The confirmed PMMR `verify failed` line needs no gate, because grin prints it only while
  opening the txhashset.
- **The confirmed PMMR line is DEBUG level.** With `file_log_level=Info` (grin's default) it is
  not in the log at all, and only the final error is. `summary.txt` says so whenever the level
  is not Debug or Trace. The text of that final error is still unknown; it is the missing part
  of the upstream issue draft.
- **OOM must name OUR pid.** Both networks run a process named `grin`, so a kernel OOM line
  refines to `killed` only if its pid equals the recorder's last pid. A `failed_start` killed
  by the OOM killer becomes `killed` / `oom_start`, with `class_initial` keeping
  `failed_start`. A panic during a start stays `failed_start` / `panic`. The two are kept apart
  because the first is the host and the second is grin.
- **Hung-task lines** count when the comm is `grin`, or when the tid is still a task of the
  live grin pid. grin names its threads, so the comm is usually not `grin`.
- **Rate limits.** There is one bundle per net per 5 min. Inside that window a capture is
  still made and classified, but it is deleted unless it shows `corrupted`. At most 3
  watchdog-restart bundles are kept per outage (`outage_captures` in `status.json`). The `down`
  bundle is not counted.
- **New `status.json` keys** (flat, before `open_outage`, and none of them shares a name with
  a nested key): `last_capture_ts`, `outage_captures` and `last_evidence`. `capture` patches
  `status.json` key by key (`_gne_jset`, with the same first-match rule as `_gne_jget`). It
  never rebuilds the file.
- **Bundle files** are as in §8.9, plus three:
  - `match.txt`: the one matched line, for the alert body. Nothing else may leave the
    bundle.
  - `start.txt`: the start window.
  - `notable.txt`: the last 2000 window lines that a class rule keys on, from the whole window.
    `grin-log.txt` keeps only the last 5000.
- **Log window.** The window runs from the last good check (for a watchdog capture, the later
  of that and the last capture) minus 2 min. For `failed_start` it starts at `start_ref`. It
  never reaches back more than 6 h.
- **Pruning** runs after each capture and from the daily stamp (`.last_prune`). The age limit
  applies to every bundle. The total cap deletes unprotected bundles oldest first, then
  protected ones (those named by a `corrupted` ledger line). It never deletes the bundle just
  written, a symlink, or a dir whose name is not a bundle name.
- **`capture <net> manual [reason]`** writes a bundle on demand, with no ledger line and no
  state change. It is meant for the operator menu.
- **The bundle dir is claimed with a plain `mkdir`, then `chmod`.** With `mkdir -m 700` in the
  claim loop, a chmod failure read as "name taken", and the harness got nine empty dirs and no
  bundle.
- **Pending-strike start time:** while a strike is pending on a vanished pid, `node_started_at` keeps the
  old start time, the same way `last_pid` does. Without that, a `.grin_last_exit` with no
  `.grin_last_start` beside it was judged stale at the tipping check, and a crash read as
  `exit_unknown`.
- **The watchdog hook** is the line in §8.9, placed after the cooldown check and the `RESTART`
  log line, before `gnc_start_node_tmux`. Existing boxes pick it up only when
  `gnk_watchdog_install` regenerates the worker. The recorder's own new files reach a box only
  through a re-install (`gne_install` now also copies `grin_log_signatures.sh`).

### 8.17 Off-box alerts

Off-box alerts: delivery is in `lib/grin_alert_send.sh` (`gas_*`); the rules and the
debounce are in `lib/grin_node_events.sh`. Where the build differs from §8.10, or adds to it:

- **082 inlines the lib; it does not source it.** `_aw_install_worker` writes the worker as
  quoted heredoc, then `cat lib/grin_alert_send.sh`, then a second quoted heredoc, all into a
  temp file that is moved into place. `/opt/grin/access-watch.sh` therefore stays ONE
  self-contained file, which is the property 082 is built on: a tamper alert must not depend
  on anything else on the box still being intact. It also means there is no new file to
  install or to break on boxes that already run 082. Each 082 launch regenerates the worker,
  as before.
  - A failed refresh, for example a missing lib, now keeps the installed worker and warns.
    Before, the half-written worker replaced it, and the error exited the menu.
  - **Behaviour diff.** Old and new workers were generated from the same source and run
    against stubbed `curl`, `sendmail`, `mail`, `msmtp`, `nak`, `nostril` and `websocat` in
    nine channel/tool combinations: all channels, HIGH and LOW, every send failing, the
    fallback tools, no tools, half a Telegram pair, ntfy only, and no conf. Every argv, every
    stdin and every `access-watch.log` line was identical.
  - The lib's knobs default to "off". 082 sets only the title, `Tags: rotating_light` and its
    `note` logger.
- **`lib/grin_alerts.sh` (Script 03) is NOT converged.** It is an older, separate copy of the
  same channel code, with its own title and `from:` line, and it reads 082's `alert.conf`
  directly. It is untouched. There are now two delivery implementations, not three.
- **Claim, then send, after the lock.** `gne_check_net` decides each alert and writes its key
  into `status.json.alerted_for` under the lock. `gne_worker_check` sends after releasing it.
  - A slow channel therefore never makes the watchdog's capture (15 s lock wait) give up on
    its evidence.
  - The guarantee is at-most-once. A send that dies half-way is lost; it is not repeated
    every 30 s.
  - Keys are claimed even when every channel fails, because §8.10 says "sent once". Nothing
    is claimed while no channel is configured, so an operator who adds a channel during an
    outage still gets its DOWN.
- **CORRUPTED stands in for DOWN.** When the class is `corrupted`, `down:<id>` is claimed with
  `corrupted:<id>`. A corrupted `failed_start` is backdated past `alert_down_after_min`, so it
  would otherwise page twice at once. The RECOVERY still follows, because it keys on `down:`. A
  DOWN already sent before a later reclass to `corrupted` is still followed by the CORRUPTED
  alert.
- **RECOVERY is sent for whatever event closes the outage.** That is `up`, a `boot` (worded
  "ended by a host reboot", counted up to the reboot) or any other closing event. It is never
  sent for an outage whose DOWN was not sent.
- **RESTART LOOP** counts `restart_by_watchdog` lines in the last 400 ledger lines that fall
  inside the window. Its key is the hour of the `ALERT_LOOP_COUNT`-th of them, so a loop that
  keeps going is re-reported about once an hour.
- **UNCLEAN HOST STOP** is one host event. Each net claims `boot:<boot_id>` in its own status,
  and the nets are merged into ONE message.
- **`alerted_for` keeps the last 20 keys, but never drops a key of the open outage.** A day-long
  restart loop adds an hourly `loop:` key, and evicting the outage's `down:` key would re-send
  its DOWN.
- **Priorities and tags.** The severities follow 082's names.

  | Alert | Severity | ntfy priority | ntfy tag |
  |---|---|---|---|
  | CORRUPTED | `HIGH` | urgent | `rotating_light` |
  | RESTART LOOP | `HIGH` | urgent | `rotating_light` |
  | DOWN | `MEDIUM` | high | `warning` |
  | UNCLEAN HOST STOP | `MEDIUM` | default | `warning` |
  | RECOVERY | `INFO` | default | `white_check_mark` |
  | `test-alert` | `INFO` | default | `information_source` |

  The title prefix is `Grin node events:`.
- **Bounds.** Each channel gets 8 s: curl `--max-time`, and `timeout` around
  sendmail/mail/msmtp/nak/nostril/websocat. Each run gets a 20 s deadline. A channel whose turn
  comes later is skipped and logged.
- **Secrets.**
  - The ntfy topic URL (since the post-build review, §8.19) and the Telegram URL, which embeds the bot token,
    reach curl on stdin (`-K -`), never argv. 082 keeps passing both in argv, unchanged.
  - **The Nostr key is still in argv** for the length of one send, in both products, because
    `nak` and `nostril` take it only as `--sec`.
  - Channel variables are function locals, never exported.
  - Warnings and the import's output name keys, never values.
- **Matched line.** The open outage's bundle is this run's capture, or `last_evidence` if it was
  taken during this outage. Its `match.txt` line is scrubbed before it goes into the body:
  - IPv4 and IPv6 are masked fully, unlike 086's `/24` mask, because an alert leaves the box;
  - absolute paths are cut to their last part;
  - `key=secret` values and 32+-character tokens are redacted;
  - the line is capped at 240 characters.

  The grin timestamp and Rust paths (`grin_chain::txhashset`) survive.
- **`recorder.conf` channel keys** are validated, and an invalid value turns that channel OFF:

  | Key | Accepted |
  |---|---|
  | `NTFY_URL` | `http(s)://`, no whitespace, quotes or backslashes |
  | `NOSTR_RELAY` | `ws(s)://`, no whitespace, quotes or backslashes |
  | `TG_BOT_TOKEN` | `<digits>:<token>` |
  | `TG_CHAT_ID` | a number, or `@name` |
  | `MAIL_TO` | one address, starting with a letter or digit, so it can never be an option to `mail`/`msmtp` |
  | `NOSTR_SK` | `nsec1…`, or 64 hex characters |

  Channel values are taken whole, so a `#` in a URL survives. Numeric keys still strip a
  trailing comment.
- **`gne_import_alert_channels`** reads 082's `alert.conf` line by line and decodes `printf %q`
  WITHOUT evaluating it.
  - A `$'…'` value or an unescaped shell metacharacter is refused.
  - It copies only keys that 082 has set. A key that 082 has empty leaves the recorder's value
    alone.
  - It writes through `gne_conf_set`, which is pure bash, so a value never reaches `sed`'s
    argv. The write is temp + `mv`, mode 0600, and replaces one line.
  - It reports the channels now active.
- **New pieces.**
  - Worker subcommand `test-alert`.
  - `gne_conf_set`, which the alert settings menu reuses.
  - `gne_status` prints the configured channel names.
  - `gne_install` copies `grin_alert_send.sh` to `/opt/grin/lib/`; `gne_remove` removes that
    copy, because only the recorder runs from it.
  - Channels set without the lib, or only half of a pair, produce a once-per-conf-edit warning.

### 8.18 Operator screens and lifecycle

The operator side: 086 has a new key `7`, **Node event recorder**, under a new
"Over time" group. Its read side is `lib/086_lib_recorder.sh` (`dgr_*`); the screens are
`rec_*` in `086_grin_diagnostics.sh`. Where the build differs from §8.12, or adds to it:

- **Sub-menu keys.** Set up is listed first, in the order a new box needs it: `I` Install /
  refresh, `P` Public status page, `A` Alert settings, `S` Status, `R` Remove. View follows:
  `1` Timeline, `2` Availability, `3` Show evidence, `4` Export, `C` Capture evidence now.
  `5` (Alert settings' old key) stays a silent alias, since nothing else took it. The header
  shows each net's state from `status.json`, says STALE when it is older than 120 s, and
  adds "next: P) publish" while the recorder is installed and no net publishes.
- **`I` ends by offering `P`.** When mainnet does not publish yet, the install screen calls
  `_rec_pub_toggle mainnet`, which asks its own `[y/N]` and explains what goes public. That
  makes I → P one pass. Only mainnet is offered, because it is what the Tiny Explorer serves.
- **`C` Capture evidence now** is new. It runs the worker's `capture <net> manual` (§8.16),
  which writes a bundle with no ledger line and no state change. It needs the recorder
  installed, because it runs the installed worker.
- **Availability is a sweep, not a state walk.** Each second of a window goes into exactly one
  bucket, with precedence unobserved > down > state:
  - **unobserved:** a `gap` interval, the tail after `status.json` went stale, time before the
    first ledger line, and states `unknown` / `unregistered`;
  - **down:** inside `[started_at, started_at + duration_s]` of a counted outage. It is an
    interval because the start is backdated (§8.4);
  - **planned:** `stopped` / `starting`;
  - **auth:** `auth_fail`. The node answers. The sweep keeps it as its own bucket, and the
    displayed percentage counts it as up (below);
  - **up:** `up`.

  Availability = (up + auth) ÷ (up + auth + down), floored, so a real outage never shows
  100.00 %. 086's Availability row and the public page (§9) use this same rule. MTBF =
  up ÷ outages that *started* in the window; mean time to recover = down ÷ outages that
  overlap it.
- **Three cases the sweep had to learn:**
  - A `boot` that closes an outage leaves the reboot window (outage end → boot line)
    unobserved. A `boot` after an `up` cannot know when the host went down, so that
    shutdown→boot time still counts as up. It is a known over-count of a few minutes per
    reboot.
  - A `recorder_start` line (a first run with no `status.json`) makes the span since the
    previous line unobserved. It also ends any outage still open at that point at the last
    line that saw it.
  - A ledger with no `status.json` beside it (restored by 089, or a recorder that never ran
    here) ends at its own last line, not at "now".
- **Export masks more than 086's support bundle.** It is `dg_maskip`, then the kept /24 (and
  IPv6 /48) masked fully, then `dg_redact`. An upstream issue is public, and a peer's /24 is
  still a fingerprint there. The box's own hostname is replaced, but only when it has 5+
  characters and is not a common word. Bundle names are swapped out around `dg_redact`,
  because at 24+ characters it would eat them. The tarball's `ledger_last200.jsonl` and
  `status.json` are IP-masked but NOT redacted, because the ledger ids are 20+ characters and
  are the point of those files. The output is
  `/opt/grin/logs/grin_node_events_export_<UTC>.tar.gz`, 0600, built under `umask 077`. The
  screen says hub 08's Disk Cleanup ages it out.
- **Alert settings** never show a value, only "set / off / half set". Tokens, the Nostr key
  and the ntfy topic URL are read without echo. A Telegram or Nostr pair is validated in
  full before either half is written (`gne_chan_valid`), so the menu cannot leave half a
  pair. New lib functions: `gne_set_channel`, `gne_set_num`, `gne_chan_valid`,
  `gne_num_specs`, `gne_chan_keys`.
- **Install offers the watchdog regeneration.** When the installed sync watchdog has no
  `grin-node-events capture` line (it predates evidence capture), `I` offers, default yes, to rerun
  `gnk_watchdog_install`. That keeps the watchdog's config and state. Without it, a watchdog
  restart destroys the pane before anything saves it.
- **Support bundle:** new file `10_recorder.txt`. It holds the install state, and per net the
  `status.json`, the last 20 ledger lines and the bundle names, IP-masked.
- **Script 01.** Super Auto's `_super_auto_harden` runs `gne_install` after the watchdog,
  without asking: Super Auto has no per-item prompts. The second net's call is a refresh. The
  custom wizard asks once per run, default YES, as Step 14c (`_offer_event_recorder`). It
  offers a refresh when the recorder is already installed. EOF declines.
- **08del.** New STEP 3c, between the systemd step and the `/opt/grin` wipe:
  - It asks to remove the recorder: worker, units, logrotate stanza, the three lib copies,
    `/opt/grin/conf/node-events/` (it holds the alert tokens) and `/opt/grin/node-events/`.
  - If bundles exist, it asks separately whether to delete them. **No** moves `evidence/`, the
    ledger files and `status.json` to `/root/grin-node-events-saved_<UTC>/` (0700).
  - If the move fails, the state dir is kept and the screen says to decline STEP 4.
- **089 backup: yes, ledger only** (decision):
  - **What goes in:** `ledger.jsonl` and its logrotate siblings, with no prompt. They are
    small, hold no secrets or IPs, and cannot be rebuilt.
  - **What stays out:** `status.json` (per-boot state) and `evidence/` (up to 500 MB of raw
    logs; export from 086 instead).
  - **Restore** writes a net's ledger only where that net has none. A live ledger is newer
    than any archive.
- **Alert-import error text:** `gne_import_alert_channels`'s error pointed at "hub 08 → 7", which is
  Disk Cleanup. Provider Access Watch is key `2`.
- **Tested locally:** a scratchpad harness that sources only the libs, against a synthetic
  13-line ledger built with the recorder's own `_gne_ledger_json`. It checked:
  - the parse field counts, and a backslash-and-`\c` reason;
  - the timeline durations (closed, ongoing, never closed);
  - the 7 / 30 / 90 d sums against hand-computed values (7 d: up 589 880 s, down 4 920 s,
    planned 6 400 s, unobserved 3 600 s → 99.17 %), identical under `gawk --posix`;
  - the restored-ledger tail;
  - masking (IPv4, IPv6, tokens, hostname, a protected bundle name) and the export
    tarball's layout;
  - the conf setters' range and pair checks, and the alert and thresholds menus driven from
    stdin.

  Not tested: mawk itself (not on the dev box), and anything that installs, removes or
  captures.
### 8.20 Launch-contract additions

All in `scripts/lib/grin_node_control.sh`. They are inert until the recorder is installed:
the marker writer returns at once while `/opt/grin/node-events/` is absent, and the pane stamps
are two small files nobody reads.

- **`_gnc_node_run_cmd <dir> <binary> [cron]`** is the ONE pane command. The launcher (both its
  `su grin` and no-grin-user branches), `gnk_autostart_enable` and Script 03 → G all build from it:

  ```
  echo Starting Grin node...; cd <dir>; echo ts=$(date -u +%s) 2>/dev/null ><dir>/.grin_last_start;
  HOME=<dir> <binary> server run; rc=$?; echo ts=$(date -u +%s) rc=$rc 2>/dev/null ><dir>/.grin_last_exit;
  echo; echo Grin process exited with status $rc. Press Enter to close.; read
  ```

  The output is literal: `$?` and `$(…)` expand only in the pane's shell, and the files are written
  as `grin`. `cron` mode backslash-escapes `$` and `%` for the crontab line. A killed SESSION writes
  no exit line, because the pane shell dies with grin; that path always goes through
  `gnc_kill_grin_session` and its marker.
- **`gnc_mark_planned_stop <session> [reason]`** writes
  `/opt/grin/node-events/<net>/planned_stop` (`ts= by= pid= reason=`), atomically and best-effort,
  under the rules in design §8.5. `gnc_kill_grin_session`, `gnc_kill_all_grin_sessions` and
  `gnc_kill_grin_procs` call it. Every stop path that SIGTERMs grin by port before any `gnc_kill_*`
  (01's `stop_grin_*`, 03's `stop_grin_node`, 07 solo, 08del, 081's remote stop) calls it, or
  `gnc_mark_all_planned_stops`, first.
- **`gnc_grin_pids_for_dir <dir>`** matches `/proc/<pid>/exe` only (design §8.13 F-7), and
  `gnc_kill_grin_procs` uses it. 01's orphan kill and 081's remote start snippet were moved off the
  cwd match too.

**What reaches an installed box, and when.** Nothing changes on a VPS by pulling the repo alone:

| Change | Reaches the box when |
|---|---|
| Recorder worker and lib copies | `gne_install` runs: 086 key 7 → `I`, Script 01's offer or Super Auto |
| The watchdog's `capture` hook | `gnk_watchdog_install` regenerates the watchdog. 086 key 7 → `I` offers it (default yes) when the installed watchdog lacks the line |
| The `@reboot` line's exit capture | Autostart is re-enabled: Script 03 → G, Super Auto, or 07 solo's boot-autostart key. Until then a boot-started run is `exit_unknown` |
| The launcher's pane stamps and marker | Immediately, for the next toolkit or watchdog start or stop: the menus and the generated watchdog both source the repo checkout's `grin_node_control.sh` |
| 082's inlined delivery code | The next 082 launch, which regenerates `/opt/grin/access-watch.sh` |

081's remote start still launches without the exit-capture tail, so remote-started runs stay
`exit_unknown` (design §8.13 F-1).

### 8.21 Classification order as built (`gne_classify`)

First match wins. A rule may also depend on the pid being alive and on the start window (`sw`:
the run never answered `get_status`, §8.16).

| # | Signature (lower-cased ERE) | Read from | Gate | Result | Status |
|---|---|---|---|---|---|
| 1 | `attempting to open (kernel\|output\|rangeproof) pmmr .*fail \(verify failed\)` | `start.txt`, `notable.txt`, pane | none | `corrupted` / `verify_failed:<mmr>` | CONFIRMED (DEBUG level, §8.16) |
| 2 | `mdb_corrupted\|mdb_page_notfound\|mdb_bad_txn\|mdb_invalid` | `start.txt`, pane | start window | `corrupted` / `lmdb` | PROVISIONAL |
| 3 | kernel OOM line naming the recorder's last pid | `kernel.txt` | pid gone | `killed` / `oom` (`oom_start` for a `failed_start`) | CONFIRMED format |
| 4 | `corrupt\|invalid ?root\|txhashset.*(invalid\|fail\|err)` | `start.txt`, pane | start window | `corrupted` / `chain_error` | PROVISIONAL |
| 5 | `panicked at` | pane, `notable.txt` | by class + pid | `hung`/`thread_panic` (pid alive), `crashed`/`panic` (gone), `failed_start`/`panic` | CONFIRMED / PROVISIONAL for the live-pid case |
| 6 | kernel hung-task line for one of our threads | `kernel.txt` | class `hung` | `hung` / `io_stall` | PROVISIONAL |
| 7 | `compact` | `notable.txt` | class `hung`, archive node | `hung` / `compaction` (never suppressed) | PROVISIONAL |
| 8 | `shutdown in progress, please wait` + `shutdown complete` | `notable.txt`, pane | class `unexplained_stop` | `unexplained_stop` / `clean_shutdown` | SEEN |
### 9. Public status page — as built

The design is [`script086_design.md`](script086_design.md) §9. **Status:** built, reviewed locally,
not VPS-tested. Accepted limits and acceptance: §9.8.

#### 9.1 The libs and their roles

| File | Role |
|---|---|
| `scripts/lib/grin_node_public.sh` (`gnp_*`) | Rendering and the chain: the label map (`gnp_kind_label`, `gnp_error_label`), `gnp_project` (status + ledger → `availability.json`, writes nothing), the privacy gate `gnp_assert_public`, `gnp_write_public` (gate, temp, `chmod 644`, `mv`), the history chain (`gnp_history_sync`, `gnp_history_append`, `gnp_verify_chain`, `gnp_history_json`, `gnp_write_history`), the salt (`_gnp_salt_load`) |
| `scripts/lib/grin_node_public_compact.sh` (`gnp_*`) | `gnp_compact_scan`: the incremental, read-only scanner of `grin-server.log`, and the compactions object. Sourced by `grin_node_public.sh` from its own dir |
| `scripts/lib/grin_node_public_run.sh` (`gne_*`, worker side) | When and how to publish: `gne_worker_publish`, `gne_worker_verify_chain`, `_gne_publish_due`, `_gne_publish_net`, `_gne_publish_off`, `_gne_public_traverse`, the `public/.lock` and the time budget. Sourced by `grin_node_events.sh` through `_gne_public_load`; it loads the renderer only when a publish or verify runs (`_gne_public_render_load`), so a plain check stays light |
| `scripts/lib/086_lib_recorder.sh` (`dgr_*`) | Unchanged code, now ALSO installed to `/opt/grin/lib`. The projection reuses `dgr_availability`, never a copy, so 086, the pool and the page share one sweep |

`gne_install` copies all four through one list, `_GNE_PUBLIC_LIBS` in `grin_node_events.sh`, and
`gne_remove` removes the same list, so the two cannot drift. A publish or verify-chain needs all
three of `gnp_history_sync`, `gnp_compact_scan` and `dgr_availability` to be defined; if any lib
is missing it refuses (rc 1, naming the files) and writes nothing. `086_lib_diag.sh` is not
copied: the worker path calls no `dg_*`. The repo may be absent on the box.

#### 9.2 Worker subcommands and `recorder.conf` keys

- `grin-node-events publish [net...]`: a net in `PUBLIC_NETS` is published now; any other net
  loses only its two served files (`_gne_publish_off`; an off net with nothing served gets no
  `public/` created). rc 1 if any net failed.
- `grin-node-events verify-chain <net>`: `gnp_verify_chain`, read-only. rc 0 `OK: N lines, head <hex>`,
  rc 1 `FAIL: line X was changed after it was chained` or no chain, rc 2 bad net. A broken link at
  line k alone means line k-1 changed; if line k is also malformed, or the link at k+1 is broken
  too, line k itself changed.
- `PUBLIC_NETS` (empty = off; net names only, anything else is dropped with a warning) and
  `PUBLIC_EVERY_S` (default 300, range 60..3600, on the same range check as the other numeric
  keys). An older `recorder.conf` without them loads as "off". `gne_status` prints one line
  ("Public status page: mainnet (last run 42s ago)" or "OFF (PUBLIC_NETS empty)").
- An existing box picks all of this up only by `I) Install / refresh`, like every recorder change.

#### 9.3 Publish order, lock and deadline

- The hook is the last call of `gne_worker_check`, after `_gne_unlock` and after the alerts. A net
  is due when it is in `PUBLIC_NETS`, its recorder dir exists, and there is no stamp, the stamp is
  `PUBLIC_EVERY_S` old (or in the future), or an outage closed in this check
  (`_GNE_PUB_CLOSED`, set in the `close` branch). The stamp `public/.last_publish` is written at the
  START of a run, so a failing net retries every `PUBLIC_EVERY_S`, not every 30 s. A net that is
  off is due only while a served file still exists.
- Due nets run as ONE separate worker process, `timeout -k 5 <left> grin-node-events publish <nets>`,
  because `timeout` cannot bound a shell function and the unit's `TimeoutStartSec=120` would
  otherwise kill the whole run. `left` = min(`GNE_PUBLISH_BUDGET_S` 60, the deadline minus the
  seconds the run already used); the deadline is min(`GNE_PUBLISH_DEADLINE_S` 100,
  `GAP_FACTOR` x 30 - 30), so a full-budget publish never makes the next check log a `gap`.
  Under 10 s left, the publish is skipped.
- Per net, in `_gne_publish_net`: net dir exists, then `_gne_public_traverse`, then `public/`
  created 0755 before the lock, then the stamp, then `flock` on `public/.lock` (30 s; **no flock
  binary means no publish**, because two writers fork the chain), then
  `gnp_history_sync` (rc not 0: publish nothing this cycle) → `gnp_write_history` → `gnp_write_availability`
  (skipped when history.json failed) → `gnp_compact_scan` (only when the node dir resolves; rc 1 is
  logged and the run carries on). The scan runs LAST on purpose: a slow scan killed by `timeout` must not stop
  the state files from refreshing. The compactions a scan appends are served by the next run. After a net's
  FIRST scan (no `.compact_scan` before the run), both files are rendered once more under the same
  lock, so `logged:false` is served only after the log has been read once.
- The recorder's own `.lock` is never taken, and `_gne_lock` is never called, by any publish function.
- `chmod o+x` on `/opt/grin` (`_gne_public_traverse`) happens only on the enabled path, only when
  the other-execute bit is missing, never on a symlink, and **only when 06d's unit file exists**
  (`GNE_TINYX_UNIT`, default `/etc/systemd/system/grin-tiny-explorer.service`; the variable is for
  tests). A failed chmod warns and the publish goes on. 04 needs no traversal.

#### 9.4 The chain, the salt and the compaction scanner

- **Sync.** With no chain, `gnp_history_sync` builds `chain_start` plus every closed outage and
  planned span in the whole ledger (all rotations), oldest first, all `"imported":true`, in a temp
  file that is moved in whole, so a backfill that fails halfway is never live. With a chain it appends
  the 90-day window's events whose `src` is not in the file yet; an event that closed more than
  `GNP_LATE_S` (7200 s) ago is marked imported. A line that fits none of the four fixed shapes is never
  written. An append is one `printf >>`; before it, a torn last line is cut back to the last complete
  line, and the last complete line must start `{"v":1,"seq":<n-1>,"type":`, else nothing is appended.
- **Salt.** `<net>/.public_salt` is created by `gnp_history_sync` only when it builds a NEW chain. With
  a chain and a missing, empty, malformed or symlinked salt, sync and append return rc 1 and write
  nothing, and `gnp_write_public` refuses. There is no unsalted fallback. The salt reaches only the
  `printf` builtin, never argv.
- **Gate.** `gnp_assert_public` has one `case` arm per file. Every `"key":` must be on that file's
  allow-list and on no forbidden list; after the keys are stripped the values must hold no IPv4,
  IPv6-like text, `.onion` or 10-digit run. Only `head`/`prev` (64 hex) and `src` (16 hex) are exempt
  from the digit check, by key and exact shape. `availability.json` also refuses any backslash or
  newline. `history.json` is checked as the exact `{v,net,lines}` wrapper and each element passes the
  `history.jsonl` arm. The gate is linear in the number of lines.
- **Locking.** No `gnp_*` function takes a lock; every writer must run under `flock` on `public/.lock`
  (sync, append, `gnp_write_history`, `gnp_write_availability`, the scan). A breach is caught by verify
  (two concurrent syncs gave duplicate `seq` values in a test).
- **Verify limits.** An edit of the LAST line breaks no link, so verify reports OK; only a reader who
  kept an earlier `chain.head` sees it.
- **Compaction scanner.** `gnp_compact_scan <net> <node_dir> [now]` finds the log through
  `_gne_node_logfile`. Matching is by fields (`<YYYYMMDD> <HH:MM:SS> <LEVEL> grin_chain::... - compact:
  finished in <n>(ms|s)`), so a peer string in another log line cannot fake one; `skipping` lines never
  match; `finished in <n>ms` is rounded to whole seconds. Log stamps are local time and are converted
  with one `date -f -`. State is `public/.compact_scan` (0600, temp + mv): `v1 <inode> <offset> <fp16> <logged>`,
  where `fp` is a hash of the file's first line. On a roll (inode or fingerprint changed, or the file shrank)
  it reads the rolled `grin-server.log.N.gz` whose fingerprint matches, from the saved offset, then newer
  rolled files whole, then the live file. Per call it reads at most `GNP_SCAN_MAX_BYTES` (64 MiB)
  and appends at most `GNP_SCAN_MAX_EVENTS` (60), saving progress inside a rolled file when a cap hits.
  It writes only `public/.compact_scan` and `history.jsonl`, holds no grin file open, and never writes
  into a node dir. The compactions object is built from the compaction lines already in `history.jsonl`.

#### 9.5 086 menu `P` (recorder sub-menu)

`rec_public` is reached by `P` ("Public status page", under Set up). Per net it shows PUBLISHING or
OFF with the last run's age. Arms: `1`/`2` toggle mainnet/testnet, `3` interval (range from
`gne_num_specs`), `4` preview, `5` verify chain, `6` whether `www-data` can read the served file,
`7` where it is served, `0` back; every arm is `|| true`-guarded. `_rec_pub_ready` gates toggle and
verify: the recorder must be installed and the worker must contain `publish)`, else the screen
points at `I) Install / refresh`. Enabling states that the page becomes public and takes only an
explicit `y`; it then runs `gne_conf_set PUBLIC_NETS` and `timeout 120 grin-node-events publish <net>`.
Disabling needs no prompt and says the chain is kept. Preview of a published net is `cat` of the
served file, byte for byte; for a net never published it prints `gnp_project` / `gnp_history_json`
from the repo libs, labelled "preview only", because the first publish also creates the salt and the
chain (so `chain` and `generated` cannot match). It never lists `public/`. "Where it is served" prints
`https://<this box's node API domain>/rest/...` and the 06d routes, never a hard-coded host.
086's Availability row (`_rec_pct`) now uses (up + auth) / (up + auth + down), and its row label is
"Auth fault (counted up)".

#### 9.6 Lifecycle and the readers

- **089.** Backup adds `public/history.jsonl` and `<net>/.public_salt` per net (regular files, not
  symlinks; manifest tag `node-events-public:`; the archive is encrypted afterwards). Served
  files, `.compact_scan` and locks are not archived. Restore handles the pair in its own loop: both
  come back only if the box has NEITHER file for that net; an archive holding one of the two restores
  nothing (warns); the salt is written with `install -m 600 -o root -g root`, and a failed salt step
  rolls the history back.
- **08del STEP 3c.** The `/opt/grin/lib` list gained the four public libs. `public/` and `.public_salt`
  are removed for both nets only when the evidence step succeeded (`ok=1`). On the "No = move" path the
  chain and the salt are first saved beside the ledger (`install -m 644` / `-m 600` into the 700 keep
  dir); a failure sets `ok=0` and nothing is deleted. The confirm prompt names "public status history".
  Everything is if-forms (errexit is live there).
- **`gne_remove`** also removes the two served files (never the chain or salt; a symlinked `public/` is
  left alone).
- **04.** `web/04_node_api/node-collector.py`, `sync_public_files(port, rest_dir, grin_data_dir)`, runs
  after `node.json` is written, in its own `try`. The net comes from the port (3413 mainnet, 13413
  testnet) or the data-dir name; it still takes three arguments. It copies ONLY `availability.json`
  and `history.json` by name from `/opt/grin/node-events/<net>/public/` (`EVENTS_ROOT`), byte for byte,
  atomically, 0644. A source that is gone, a symlink, over 8 MiB, not valid JSON or not UTF-8 removes the
  served copy. No nginx change (the `^/rest/[^/]+\.json$` rule serves them). The status page has an
  "Availability" section (`web/04_node_api/public_html/` `index.html`, `css/status.css`, availability script): hidden
  unless `/rest/availability.json` is 200 with `v:1` and at least one window; text only
  (`textContent`); a record whose `generated` is over 3 h old reads `Unknown`; a "check it yourself"
  `get_tip` POST on `/v2/foreign` plus the verify recipe; a browser-side chain check with
  `crypto.subtle`. `node-status.js` lists both files in "Available endpoints" ("when published").
- **06d.** `tiny-explorer-server.js`: `readAvailability(name)` accepts only the two names, requires a
  regular file (a symlink is refused), 1 byte to 8 MiB, an object with `v:1` whose top-level keys are on
  the published list, and serves the raw text unchanged with `Cache-Control: public, max-age=30` and a
  30 s TTL cache (`availability_cache_ms`). `GET /api/availability` and `/api/availability/history`
  answer 404 `{"error":"not published"}` on any miss, never a 500. The page is `GET /availability`
  (`web/06d_tiny_explorer/public/availability.html` and its availability script, via `sendEntityPage`; `/availability.html`
  redirects to it through `HTML_TWINS`). Config key `availability_dir` (default
  `/opt/grin/node-events/mainnet/public`), written by `scripts/lib/06d_tiny_explorer.sh` and read back
  only if it is a plain absolute path. **Sitemap gate:** `availPublished()` is true exactly when
  `/api/availability` would answer 200 (same cache). The sitemap row is listed, `index, follow` is
  served, `window.TINYEXP_AVAIL` is true and `tiny-explorer.js` adds the footer link "Node availability"
  only while it is; with publishing off the page is `noindex, follow` and unlisted. Compaction rows
  of 0 s render as "< 1 s" on both pages (the JSON keeps integer seconds).

#### 9.7 Tests, as run

Harnesses are scratchpad-only and are not in the repo; what they exercised:

- **Core and privacy:** every key of both public files is on its allow-list; an open outage, a
  `reason`, IPs, onions, quotes, newlines and `\037` never reach a public file; hostile class/sub
  values publish as `unknown`/`null`; window percentages match hand-computed values; all rows of the
  label map; the gate refused dozens of hostile payloads and wrappers. A brute-force search of every
  published `src` over its date finds nothing (and finds the exact second when the salt is supplied).
- **Chain:** rerun adds no lines; one edited byte makes verify name the line; a torn tail is cut,
  never chained over; the shell recipe walks every link with the served bytes (with a stand-in for
  `jq`).
- **Compaction scanner:** both log forms and units, rotation (one roll, two rolls, inode reuse,
  truncation, a missing `.gz`), local-time conversion across midnight, the 64 MiB / 60-event caps, a
  node-dir snapshot that is identical before and after.
- **Worker:** install and remove copy and remove the four libs; files appear within one cycle; an
  empty `PUBLIC_NETS` writes nothing; disabling removes only the served files; a re-enable extends the
  same chain; a missing lib or salt fails closed; the hook runs after unlock; a hung publish is cut
  and the check still returns 0; the stale-record and `gne_remove` cases.
- **Menu, lifecycle, web:** the menu arms against the real worker; the 089 restore rules and the
  08del move path on fixtures; the 04 page (fake DOM that throws on `innerHTML`) in six hide/show
  cases; the collector copy and removal with real Python; the 06d routes with an in-memory fs and
  once against a live local server; `npm test` in `web/06d_tiny_explorer`.
- **Linux:** the main fixtures were re-run under WSL (real `mawk`, real `flock`, real modes and
  symlinks): a 9,000-line chain renders and gates in about 9 s.

Not tested: a real browser, real `jq`, `timeout` killing under systemd, `stat -c %a` on a real
`/opt/grin`, a real grin log from a patched node.

## Runbook

- **Install or refresh the recorder:** 086 key 7 → `I` (re-running it is how a box picks up a toolkit update; it offers to regenerate the sync watchdog when that has no `capture` line). Script 01 offers it in its wizard and installs it in Super Auto.
- **Look at what happened:** key 7 → `1` Timeline, `2` Availability, `3` Show evidence, `4` Export (masked tarball for an upstream issue), `C` Capture evidence now. Set up: `I` Install / refresh, `P` Public status page, `A` Alert settings, `S` Status, `R` Remove.
- **Remove:** key 7 → `R`, or 08del STEP 3c (asks about the alert tokens in `conf/node-events/` and, separately, the evidence bundles).
- **What reaches an installed box, and when:** the table in §8.20.
- **Acceptance procedure (testnet first, then mainnet):** §8.22.
- **Publish the node page:** key 7 → `P` (per-net on/off, interval, preview, verify chain, readability by `www-data`, where it is served). By hand: `grin-node-events publish <net>`, `grin-node-events verify-chain <net>`. Details and the acceptance list: §9, §9.8.

## Build notes — obstacles & lessons

Section numbers §8.15–§8.22 are permanent IDs (code comments cite "086 §8.15" and the pool doc cites §8.22). The full pre-G7 text of the dated build records, including the post-build review's "checked, nothing found" list: `git log -- docs/reference/script086_implementation.md`, the commit before the G7 re-org (2026-10-13). Everything below was found by local harnesses and cold review; **none of it has run on a VPS.**

### 8.19 Post-build review findings (fixed)

#### A slow toolkit stop counted as a `hung` outage
**Symptom:** a 3-minute exit after a planned stop opened `down hung` and paged DOWN. **Cause:** the planned-stop marker for the live pid was read only once the pid had gone; meanwhile two failed checks were two strikes. grin may keep exiting long after SIGTERM (Script 01 waits up to 300 s). **Fix:** while a valid marker (§8.5) names the live, unchanged pid, a failed check is not a strike; `MARKER_TTL_MIN` bounds it, after which a kill that never landed goes `stale_marker` and strikes resume. A marker with `pid=0`, a different pid or `by=grin-node-sync-watchdog` still strikes. **Lesson:** read the marker while the process is still alive, and bound every "expected" window.

#### `no_secret` turned a stopped node into a false outage
**Symptom:** a rebuild on a box with no vault entry produced `unexplained_stop`. **Cause:** the rebuild wiped the secret with the dir, which moved `stopped` to `unknown` but kept the old `last_pid`, so the rebuilt node's start struck as "pid changed". **Fix:** with no pid, `no_secret` is judged `refused` (nothing to authenticate against), so a stopped node stays stopped; a vanished node still strikes; with a live pid it stays `unknown`. **Lesson:** a state change must clear the identity fields that only made sense in the old state.

#### The ntfy topic URL was in curl's argv
**Symptom:** the menu reads the URL hidden because the URL is the credential, but delivery put it in `ps`. **Fix:** under `GAS_HIDE_SECRETS` it goes on stdin (`-K -`) like Telegram's; 082 does not set that knob, so its argv is unchanged (diffed against a stubbed curl). The Nostr key still reaches `nak`/`nostril` through argv for one send, because they take it only as `--sec`.

### Classification and capture

#### The watchdog restarts faster than the recorder can see
**Symptom (avoided):** a restart loop the watchdog catches early would read as 100 % available. **Cause:** the watchdog acts on one failed probe every 5 min; the recorder needs two 30 s strikes, so the watchdog can restart a node the recorder still calls `up`, and rule 7 would count that restart as planned. **Fix:** when the recorder is `up`, `capture … watchdog_restart` writes a `down` line and then `restart_by_watchdog`; in `starting`, `stopped`, `auth_fail` and `unknown` it opens nothing. **Lesson:** two observers with different cadences must not each be the source of truth for "planned".

#### Capture writes the event before the evidence
**Symptom (avoided):** a timeout inside the watchdog's 20 s budget losing the event itself. **Fix:** the capture path writes ledger and status first and the bundle after, so a timeout can lose evidence but never the event; a class refined by the bundle arrives as a separate `reclass` line (the check path, which is not under that budget, captures first and renames the bundle dir to the refined class). The bundle dir is claimed with a plain `mkdir` then `chmod` — with `mkdir -m 700` in the claim loop a chmod failure read as "name taken" and a harness produced nine empty dirs and no bundle.

#### OOM and hung-task lines must name OUR process
**Symptom (avoided):** a kernel OOM line for the other network's `grin` refining this node to `killed`. **Cause:** both networks run a process named `grin`, and grin names its threads, so the comm of a hung task is usually not `grin`. **Fix:** an OOM line refines to `killed` only when its pid equals the recorder's last pid (a `failed_start` killed by the OOM killer becomes `killed`/`oom_start`, a panic during a start stays `failed_start`/`panic` — the first is the host, the second is grin); hung-task lines count when the comm is `grin` or the tid is still a task of the live grin pid. **Lesson:** match on pid, never on the process name.

#### The confirmed `verify failed` line is DEBUG level
With grin's default `file_log_level=Info` the PMMR line is not in the log at all — only the final error is, and its text is still unknown (the missing part of the upstream issue draft). `summary.txt` says so whenever the level is not Debug or Trace.

#### A pending strike on a vanished pid lost its start time
**Symptom:** a crash read as `exit_unknown`. **Cause:** `.grin_last_exit` with no `.grin_last_start` beside it was judged stale at the tipping check once `node_started_at` had moved. **Fix:** while a strike is pending on a vanished pid, `node_started_at` keeps the old start time, the same way `last_pid` does.

### Alerts

#### Send after releasing the lock, claim before it
`gne_check_net` decides each alert and writes its key into `status.json.alerted_for` under the lock; `gne_worker_check` sends after releasing it. A slow channel therefore never makes the watchdog's capture (15 s lock wait) give up on its evidence. The guarantee is at-most-once: a send that dies half-way is lost, not repeated every 30 s. Keys are claimed even when every channel fails ("sent once"), but nothing is claimed while no channel is configured, so an operator who adds a channel mid-outage still gets the DOWN. `alerted_for` keeps the last 20 keys but never drops a key of the open outage — a day-long restart loop adds an hourly `loop:` key and evicting the `down:` key would re-send it. **Lesson:** decide under the lock, perform side effects outside it.

#### Importing 082's alert conf without evaluating it
`gne_import_alert_channels` reads 082's `alert.conf` line by line and decodes `printf %q` without `eval`; a `$'…'` value or an unescaped metacharacter is refused; it copies only keys 082 has set and writes through the pure-bash `gne_conf_set` (temp + `mv`, 0600), so a value never reaches `sed`'s argv. **Lesson:** a config file written by another product is untrusted input.

#### 082 inlines the delivery lib instead of sourcing it
A tamper alert must not depend on anything else on the box still being intact, so `_aw_install_worker` writes the worker as quoted heredoc + `cat lib/grin_alert_send.sh` + a second quoted heredoc into a temp file and moves it into place; `/opt/grin/access-watch.sh` stays ONE self-contained file. A failed refresh (for example a missing lib) now keeps the installed worker and warns — before, the half-written worker replaced it and the error exited the menu. Old and new workers were run against stubbed `curl`/`sendmail`/`mail`/`msmtp`/`nak`/`nostril`/`websocat` in nine channel combinations with identical argv, stdin and log lines. Script 03's older `lib/grin_alerts.sh` is not converged (Open items).

### Operator side

#### Availability is a sweep, not a state walk
Each second of a window goes into exactly one bucket, precedence unobserved > down > state; availability = (up + auth) ÷ (up + auth + down), floored so a real outage never shows 100.00 % (an `auth_fail` node answers, so it counts as up; 086's row and the public page agree). Three cases the sweep had to learn: a `boot` that closes an outage leaves the reboot window unobserved (while a `boot` after an `up` over-counts a few minutes per reboot); a `recorder_start` line makes the span since the previous line unobserved and ends any outage still open; a ledger with no `status.json` beside it ends at its own last line, not at "now". **Lesson:** make every instant belong to exactly one bucket, then state the precedence.

#### Export is public, so it masks more than the support bundle
An upstream issue is public and a peer's /24 is still a fingerprint there, so export masks IPv4 /24 and IPv6 /48 fully after `dg_maskip`, replaces the box's own hostname (5+ characters, not a common word), and swaps bundle names out around `dg_redact` (24+ character tokens would be eaten). The tarball's `ledger_last200.jsonl` and `status.json` are IP-masked but not redacted, because ledger ids are 20+ characters and are the point of those files.

#### Fixed `hub 08 → 7` pointer
`gne_import_alert_channels`' error pointed at "hub 08 → 7", which is Disk Cleanup; Provider Access Watch is key `2`.

### Public status page

#### The history gate was quadratic
**Symptom:** at 2,000 history lines the `history.json` gate alone took longer than the 60 s publish budget on Linux, `timeout` killed it on every run, and `availability.json` was never rewritten again, so the page kept saying `up` while the node was down. **Cause:** the gate cut the rest of the body once per line, and each `=~` recompiled its regex. **Fix:** one substitution turns the separators into newlines and the gate tries only the shape the line's `type` names; the render is one `head | sed | paste` pipeline. **Lesson:** time a gate at a realistic size on the real OS (WSL), not on the dev shell.

#### A scan before the state files starved them
**Symptom (found in review):** the compaction scan ran before the writes, so a slow scan killed by `timeout` left the served state frozen. **Fix:** the writes run first and the scan last. **Lesson:** order optional, slow work after the work that keeps the page honest.

#### A freshness check on the readers
**Symptom (found in review):** after `gne_remove`, or with a dead timer, the last `availability.json` stayed in `public/` and both pages kept showing "up". **Fix:** `gne_remove` takes the served files down and both pages treat a `generated` over 3 h old as Unknown. **Lesson:** a page fed by a producer must notice that the producer stopped.

## Open items

### 8.19 Open findings (need a decision or a VPS)


- **The check-path capture can lose its own `down` line** (unconfirmed).
  - The check captures evidence BEFORE it writes the ledger and status (§8.16). The oneshot
    unit has `TimeoutStartSec=120`.
  - If the box thrashes and the capture takes longer, for example zcat of the rotated logs on
    a 4 GB archive box, systemd kills the check. Neither the `down` line nor `status.json` is
    written.
  - The next check sees the same strikes, opens the outage again and captures again.
  - Options: a larger timeout, a time budget on `_gne_log_stream`, or the capture path's
    order (write first, then `reclass`).
- **A watchdog restart that the capture did not record reads as a planned `start`.**
  - This happens when the capture gives up on a lock busy for over 15 s (two 8 s probe
    timeouts plus the check-path capture), or when the watchdog predates the hook.
  - In state `up` the only trace is then the `by=grin-node-sync-watchdog` marker. Rule 7
    turns that into `start`, and nothing is counted.
  - Mirroring §8.16 (open an outage from `up`) needs a class choice: the watchdog's reason is
    lost by then.
- **A marker whose kill failed explains too much for one TTL.** For up to `MARKER_TTL_MIN`, a
  real crash of that pid reads as a planned `stop`, and a hang gets no strikes. This is accepted
  as the price of the first fix.

### 8.22 Status and acceptance

- **Built:** the recorder (this file) and the pool side (
  `script07_implementation.md` §10.15). **Never run on a VPS.**
- **Acceptance (operator):** on TESTNET first — install from key 7 and see the timer fire
  every 30 s; a toolkit stop + start gives one planned event and no outage; `kill -9` gives
  `killed` with a bundle, then `restart_by_watchdog` and `up` with a duration; `kill -STOP` for
  90 s gives `hung`; Ctrl+C in `gtmux` gives `unexplained_stop`; a reboot gives `boot` and no
  outage; a 7-byte-truncated `kernel/pmmr_hash.bin` on a THROWAWAY copy gives `failed_start`
  refined to `corrupted` plus a HIGH alert; `test-alert` reaches every channel; a 10-minute outage
  sends exactly one DOWN and one RECOVERY; 082 still alerts as before. Then mainnet, left running
  a week.
- **Open from the post-build review** (§8.19): the check-path capture can lose its own `down` line under
  `TimeoutStartSec=120` on a thrashing box; a watchdog restart whose capture gave up on the lock
  reads as a planned `start`; a marker whose kill failed explains too much for one TTL.
- **Deferred** (design §8.14): the watchdog backing off on `corrupted`; a fleet view in 081; the
  `gnc_owner_get_status` argv fix (F-3); converging Script 03's older `lib/grin_alerts.sh` onto
  `grin_alert_send.sh` (§8.17).
- The public status page (§9) has its own accepted limits and acceptance steps in §9.8.
- When acceptance passes, record it in this header's *Last verified* with its scope.

### 9.8 Public status page: accepted limits, and what is owed

**Status:** built, not VPS-tested.

**Accepted limits** (the operator accepted each on 2026-10-27):

- **`stopped` shows as `down`.** The node does not answer; planned time is still kept out of the percentage.
- **A watchdog restart with no down line is not in history.** It is not an outage and has no duration.
- **A span cut by `recorder_start` is not listed.** It has no measured end; the sweep still counts its time.
- **An open outage's start can be derived to about a minute** (the 7-day percentage times observed time, or the forced publish's `generated` plus a duration). The live `state` already gives it away and no timestamp field is published.
- **Labels are frozen when a line is appended.** A reclass lands about 20 s after the down, before any close, so the two views agree in practice.
- **Rolled `.gz` logs are not back-filled on the first scan.** A first scan has no inode to key them on, so only compactions after enabling are listed.
- **Inode reuse at the same offset could hide one compaction.** It needs the same inode number and byte offset; the key is salted.
- **A publish can delay the NEXT check's start** by up to about 75 s at the default, at most once per `PUBLIC_EVERY_S` or per closed outage. The watchdog's capture never waits (different lock).
- **`public/.last_publish` and `public/.lock` are 0644.** No reader serves them; the stamp is about the public `generated`.
- **04's section is hidden until the collector's next minute, and for good if 04's collector is not installed.** By design: 06d reads the file directly.
- **"Not logged by this grin build" can be served until a later scan** if the very first scan on a net is killed by `timeout`, or the first live log is over 64 MiB. Closing it needs a public "not scanned yet" signal, which is a change to the contract in design §9.4, so that contract is kept frozen.
- **06d reads the files only after the first publish adds `o+x`** on `/opt/grin`; until then, or if that chmod fails (a warning on stderr), `/api/availability` answers 404 and the page says "not published".
- **06d checks top-level keys only.** The recorder's gate is the real control; the server check is defence in depth.
- **089 restore needs the complete pair in the archive;** an archive from before publishing was enabled has none.
- **The collector can lose a race with the publisher's removal** between `lexists` and `open`: a warning only, recovered the next minute.
- **The head can briefly differ from the history** (separate caches: 30 s on 06d, 1 min on 04). Both pages then print "entries link correctly" without "head matches", never a false alarm.
- **The pages use inline `style=` attributes, px font sizes and no `defer`,** matching the pages around them.
- **Capacity.** The gate costs about 1 ms per history line on Linux (9,000 lines, about 9 s). At the fastest expected pace (an archive node on a build that logs compactions) that stays under the 60 s budget for years; revisit with a batch gate if the chain passes about 40,000 lines.

**Owed at VPS acceptance (operator):**

- **Time the first archive-box publish** (a capped scan slice on a large log); the cap and the budget were sized from a Windows run.
- **A real browser and real `jq`.** The verify recipe and the `curl` lines were run only with stand-ins for `jq`; no browser has opened either page.
- **Also unproven here:** `timeout` killing the worker under systemd, `stat -c %a` on a real `/opt/grin`, and a real log from a patched node.
- **The acceptance steps, testnet first:** enable from 086 → recorder → `P` and the page shows `up`; `kill -9` the node and, after recovery, one outage row with kind `killed` appears; `verify-chain` prints OK; edit one byte of a copy of `history.jsonl` and verify names the line; the `curl` line answers. Then mainnet on the node-API box, then the archive box. Record the result in this doc with its scope.
