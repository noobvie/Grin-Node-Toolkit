# Script 086 — Diagnostics & Support Bundle (Implementation)

> **Covers code as of:** 2026-10-03 — §8 only, written against the uncommitted working tree that
> holds the node event recorder (Parts 1–5 and the R1 fixes). §8.15–§8.19 were written by the
> sessions that built each part and moved here unchanged from `script086_design.md` on 2026-10-03;
> the file map, §8.20 and §8.21 were read against the code on that day ·
> **Last verified:** 2026-10-03, PARTIAL — §8 only. The R1 review (§8.19) checked the read-only gate
> by grep, the transitions and the debounce with a local harness over the pure functions, and the
> launch command through stubbed `su`/`tmux`/`grin`. The docs-fold session re-read the file map,
> §8.20 and §8.21 against the libs (function names, paths, unit and logrotate text, the order of
> `gne_classify`'s rules). **Nothing has been installed or run on a VPS** ·
> **Product code last changed:** 2026-10-03 — `scripts/lib/grin_node_events.sh`,
> `scripts/lib/086_lib_recorder.sh`, `scripts/lib/grin_alert_send.sh`,
> `scripts/lib/grin_log_signatures.sh` (all new), `scripts/lib/grin_node_control.sh`,
> `scripts/lib/grin_node_keepalive.sh`, `scripts/lib/086_lib_diag.sh`, `scripts/086_grin_diagnostics.sh`,
> `scripts/082_provider_access_watch.sh`, `scripts/01_build_new_grin_node.sh`,
> `scripts/03_grin_share_chain_data.sh`, `scripts/07_grin_mining_solo.sh`, `scripts/081_host_monitor_port.sh`,
> `scripts/08del_clean_all_grin_things.sh`, `scripts/089_backup_restore.sh` (uncommitted)

The design is [`script086_design.md`](script086_design.md). Keys 1–6 (health check, support bundle,
API performance, log triage, consumer load test, saved reports) have no separate as-built record:
their design doc §1–7 was written with the code on 2026-09-25 and doubles as one. This file holds
the as-built record of the **node event recorder** (key 7).

**The section numbers continue the design's §8.** The design's §8.1–§8.14 are the recorder's
design; §8.15 onward are here. Code comments that say "086 §8.15" or "086 §8.18" therefore resolve
to this file, and the design keeps a pointer under the same numbers.

---

## 8. Node event recorder — as built (2026-10-03, NOT VPS-tested)

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
/opt/grin/conf/node-events/recorder.conf        0600  written only when absent
/opt/grin/node-events/                          0755  creating it is what turns the planned-stop markers on
  <net>/  0755 (only for nets in the instances conf)   <net>/evidence/  0700
```

- `delaycompress` keeps `ledger.jsonl.1` plain, which is the one rotated file the pool's ingest
  finishes (07 implementation §10.15).
- `gne_remove` removes the worker, both units, the logrotate stanza and three lib copies. It leaves the
  `grin_node_control.sh` copy in place, and keeps the state, the evidence and the conf. 08del
  removes those, asking about evidence first.
- Schemas are as in design §8.8, with the extra flat `status.json` keys listed in §8.15 and §8.16.

### 8.15 Part 2 as-built deltas (2026-10-03, never run)

Part 2 built the recorder core in `scripts/lib/grin_node_events.sh`: `gne_decide` (§8.4 as one pure
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
- **An outage that spans a `gap` keeps wall-clock `duration_s`.** Part 5's availability maths must
  subtract `gap` intervals that overlap an outage.
- **`status.json` is one line**, with extra keys beside §8.8's: `sub_state`, `last_pid`,
  `grin_version_key`, `start_ref`, `last_outage_end`, flat copies of the open outage
  (`outage_id`, `outage_started_at`, `outage_class`), `pending_restart_ts` and
  `last_id_ts`/`last_id_seq` (the per-second `seq` of ledger ids, which survives a capture writing
  in the same second). `open_outage` is written last. The worker parses only the flat keys.
- **The worker sources `/opt/grin/lib/grin_node_control.sh` and `grin_node_events.sh`,** both copied
  there by `gne_install`. Re-running the install is how a box picks up a toolkit update.
  `gne_install` creates `/opt/grin/node-events/` 0755, which turns on Part 1's markers.
- **`capture` is a stub** that exits 0, so the Part 3 watchdog hook can never fail a restart.
  (Part 3 filled it in; see §8.16.)

### 8.16 Part 3 as-built deltas (2026-10-03, never run)

Part 3 built evidence capture, classification and the watchdog hook. The signature table
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
  - `match.txt`: the one matched line, for Part 4's alert body. Nothing else may leave the
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
  state change. It is meant for Part 5's menu.
- **The bundle dir is claimed with a plain `mkdir`, then `chmod`.** With `mkdir -m 700` in the
  claim loop, a chmod failure read as "name taken", and the harness got nine empty dirs and no
  bundle.
- **A Part 2 fix:** while a strike is pending on a vanished pid, `node_started_at` keeps the
  old start time, the same way `last_pid` does. Without that, a `.grin_last_exit` with no
  `.grin_last_start` beside it was judged stale at the tipping check, and a crash read as
  `exit_unknown`.
- **The watchdog hook** is the line in §8.9, placed after the cooldown check and the `RESTART`
  log line, before `gnc_start_node_tmux`. Existing boxes pick it up only when
  `gnk_watchdog_install` regenerates the worker. The recorder's own new files reach a box only
  through a re-install (`gne_install` now also copies `grin_log_signatures.sh`).

### 8.17 Part 4 as-built deltas (2026-10-03, never run)

Part 4 built off-box alerts. Delivery is in `lib/grin_alert_send.sh` (`gas_*`); the rules and the
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
  directly. Part 4 did not touch it. There are now two delivery implementations, not three.
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
  - The ntfy topic URL (since R1, §8.19) and the Telegram URL, which embeds the bot token,
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
  - `gne_conf_set`, which Part 5's alert settings will reuse.
  - `gne_status` prints the configured channel names.
  - `gne_install` copies `grin_alert_send.sh` to `/opt/grin/lib/`; `gne_remove` removes that
    copy, because only the recorder runs from it.
  - Channels set without the lib, or only half of a pair, produce a once-per-conf-edit warning.

### 8.18 Part 5 as-built deltas (2026-10-03, never run)

Part 5 built the operator side. 086 has a new key `7`, **Node event recorder**, under a new
"Over time" group. Its read side is `lib/086_lib_recorder.sh` (`dgr_*`); the screens are
`rec_*` in `086_grin_diagnostics.sh`. Where the build differs from §8.12, or adds to it:

- **Sub-menu keys.** View: `1` Timeline, `2` Availability, `3` Show evidence, `4` Export,
  `C` Capture evidence now. Set up: `5` Alert settings, `I` Install / refresh, `R` Remove,
  `S` Status. The header shows each net's state from `status.json`, and says STALE when it is
  older than 120 s.
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
  - **auth:** `auth_fail`. The node answers, but this time is judged as neither up nor down;
  - **up:** `up`.

  Availability = up ÷ (up + down), floored, so a real outage never shows 100.00 %. MTBF =
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
  `grin-node-events capture` line (it predates Part 3), `I` offers, default yes, to rerun
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
- **089 backup: yes, ledger only** (Part 5's decision):
  - **What goes in:** `ledger.jsonl` and its logrotate siblings, with no prompt. They are
    small, hold no secrets or IPs, and cannot be rebuilt.
  - **What stays out:** `status.json` (per-boot state) and `evidence/` (up to 500 MB of raw
    logs; export from 086 instead).
  - **Restore** writes a net's ledger only where that net has none. A live ledger is newer
    than any archive.
- **Fix in Part 4 text:** `gne_import_alert_channels`'s error pointed at "hub 08 → 7", which is
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

### 8.19 R1 review of Parts 1–5 (2026-10-03, never run)

A cold review of Parts 1–5 against §8.2–§8.12. Its checks were: §8.2's read-only gate (by grep);
the launch command, expanded through stubbed `su`, `tmux` and `grin`; and `gne_decide` and
`_gne_alerts_decide`, driven by a local harness. **Fixed:**

- **A slow toolkit stop counted as a `hung` outage.** The marker for the live pid was read only
  once the pid was gone. Meanwhile, two failed checks opened `down hung`, and a 3-minute exit
  also paged DOWN. grin may still be exiting long after SIGTERM: Script 01 waits up to 300 s.
  - *Fix:* while a valid marker (§8.5) names the live, unchanged pid, a failed check is not a
    strike.
  - *Bound:* `MARKER_TTL_MIN`. A kill that never lands goes `stale_marker`, and the strikes
    resume.
  - A marker with `pid=0`, a different pid or `by=grin-node-sync-watchdog` still strikes.
  - Whether grin's API stops answering during shutdown at all is unknown. Part 10 step 2 shows
    it.
- **`no_secret` turned a stopped node into a false outage.** A rebuild on a box with no vault
  entry wipes the secret with the dir. That moved `stopped` to `unknown` but kept the old
  `last_pid`. The rebuilt node's start then struck as "pid changed" and opened an outage
  (`unexplained_stop`).
  - *Fix:* with no pid, `no_secret` is judged as `refused`, since there is nothing to
    authenticate against. A stopped node stays stopped. A vanished node still strikes. With a
    live pid it is `unknown`, as before.
- **The ntfy topic URL was in curl's argv.** 086's menu reads it hidden because the URL is the
  credential. Under `GAS_HIDE_SECRETS` it now goes on stdin like Telegram's. 082 does not set
  that knob, so its argv is unchanged (diffed against a stubbed curl).

**Open (not fixed, needs a decision or a VPS):**

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

**Checked, nothing found:**

- The read-only gate: the worker's only deletes are inside `$GNE_EVENTS_DIR`, its temp dirs and
  `recorder.conf`. It makes no signal, launch, `systemctl` or node-dir write.
- The launcher in both branches and the cron line (both readings of `\%`): `$?` reaches the
  pane, `.grin_last_exit` gets `rc=101`, and `read` stays last.
- Errexit endings and menu `||`-guards.
- The heredocs: the worker body and the watchdog's hook are quoted.
- 082's delivery argv.
- Debounce: a 3 h outage with a watchdog restart every 20 min sends one DOWN, one RECOVERY and
  three LOOP alerts, 40–60 min apart.
- Rotation: rename + `create`.
- Pruning: oldest first, protected bundles last, never the bundle just written.

### 8.20 Launch-contract additions (Part 1)

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

### 8.22 Status and acceptance

- **Built:** Parts 1–5 and the R1 fixes (this file), and the pool side (Parts 6–8 and the R2 fixes:
  `script07_implementation.md` §10.15). **Never run on a VPS.**
- **Acceptance (Part 10, operator):** on TESTNET first — install from key 7 and see the timer fire
  every 30 s; a toolkit stop + start gives one planned event and no outage; `kill -9` gives
  `killed` with a bundle, then `restart_by_watchdog` and `up` with a duration; `kill -STOP` for
  90 s gives `hung`; Ctrl+C in `gtmux` gives `unexplained_stop`; a reboot gives `boot` and no
  outage; a 7-byte-truncated `kernel/pmmr_hash.bin` on a THROWAWAY copy gives `failed_start`
  refined to `corrupted` plus a HIGH alert; `test-alert` reaches every channel; a 10-minute outage
  sends exactly one DOWN and one RECOVERY; 082 still alerts as before. Then mainnet, left running
  a week.
- **Open from R1** (§8.19): the check-path capture can lose its own `down` line under
  `TimeoutStartSec=120` on a thrashing box; a watchdog restart whose capture gave up on the lock
  reads as a planned `start`; a marker whose kill failed explains too much for one TTL.
- **Deferred** (design §8.14): the watchdog backing off on `corrupted`; a fleet view in 081; the
  `gnc_owner_get_status` argv fix (F-3); converging Script 03's older `lib/grin_alerts.sh` onto
  `grin_alert_send.sh` (§8.17).
- When acceptance passes, record it in this header's *Last verified* with its scope.
