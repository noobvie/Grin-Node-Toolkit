# Script 082 — Provider / Host-Access Tamper Watch: implementation

> **Covers code as of:** 2026-07-25 (the doc: "BUILT 2026-07-25"); the *Alert design* section
> 2026-10-03 · **Last verified:** never systematically verified
> **Product code last changed:** 2026-10-03 — `scripts/082_provider_access_watch.sh` (alert
> delivery moved into `scripts/lib/grin_alert_send.sh`, inlined into the worker; no behaviour change)
> The menu-key note was updated 2026-08-06; the rest is the 2026-07-25 build.

> **Scope:** the signals, state layout, alert delivery, menu and conventions as built, plus the Build notes. The threat model and tamper-evidence reasoning are `script082_design.md`.

**Status:** BUILT 2026-07-25 (add-ons branch), NOT VPS-tested.
**Entry:** Admin Centre (08) → Monitoring → `2) Provider Access Watch`
(key = sub-script number since the 2026-08-05 re-sort: 082 → key 2. It first
landed on key 7, which is what put Backup 089 on key 10.)
**Files:** `scripts/082_provider_access_watch.sh` (menu front-end) →
installs worker `/opt/grin/access-watch.sh` + `grin-access-watch.service`/`.timer`.

## What shipped

### Signals detected

| Signal | Source | Severity |
|---|---|---|
| New / removed `authorized_keys` entry | every user's `~/.ssh/authorized_keys`, keyed by `ssh-keygen -l` fingerprint | NEW = HIGH, removed = MED |
| Changed sshd binary / sshd_config(+drop-ins) / sudoers(+.d) / passwd / group / crontab / cron.d / systemd `.service`+`.timer` / hosts.allow/deny / ld.so.preload | SHA-256 manifest diff | MED (HIGH if it's a key/cmdline) |
| Reboot you didn't trigger | `/proc/sys/kernel/random/boot_id` change | MED |
| Kernel changed | `uname -r` | MED |
| Kernel cmdline changed | sha of `/proc/cmdline` (catches `init=`, `single`, rescue) | HIGH |
| New SSH login accepted | journald `_COMM=sshd` "Accepted", fallback auth.log/secure | event (LOW) |
| VM pause / clock jump | heartbeat gap ≫ interval with **no** boot_id change | event (LOW) |

### State layout (`/opt/grin/conf/access-watch/`, dir 700)

- `baseline` — sorted manifest (`authkey …`, `file <path> <sha|MISSING>`, `bootid`, `btime`, `cmdline`, `kernel`), chmod 600.
- `alert.conf` — channel secrets, chmod 600, `%q`-quoted for safe `source`. Keys: `NTFY_URL`, `TG_BOT_TOKEN`+`TG_CHAT_ID`, `MAIL_TO`, `NOSTR_SK`+`NOSTR_RELAY`, `ALERT_ON_LOGIN` (default 1).
- `state/` — `baseline_hash`, `baseline_time`, `last_seen` (epoch heartbeat), `interval_seconds`, `seen_logins` (sha set, primed at baseline, capped 1000→500), `last_report`, `last_status`, `last_check_time`, `last_alert_hash`.

### Alert design (mirrors pool `alert-delivery.js`)

`notify(severity, subject, body)` sources `alert.conf` and calls `gas_send`, which sends to
**every** configured channel. Each channel is independent (`note sent` / `note FAILED`), so
one failing never blocks the rest.

**Where the code lives (since 2026-10-03).** The delivery code is `scripts/lib/grin_alert_send.sh`,
which the node event recorder (086 design §8.10) shares. `_aw_install_worker` **inlines** it
between the worker's two quoted heredocs, so `/opt/grin/access-watch.sh` is still one
self-contained file that sources nothing. Edit the lib, not the generated copy.
- The worker sets `GAS_TITLE_PREFIX="Grin VPS access-watch"`, `GAS_NTFY_TAGS=rotating_light`
  and `GAS_LOG_FN=note`, and nothing else. Every other knob stays off, so its requests and log
  lines are byte-for-byte the pre-extraction ones. This was checked in nine stubbed
  channel/tool combinations (086 implementation §8.17).
- The worker is built in a temp file and moved into place. If the lib is missing, the
  installed worker is kept and the menu warns.

The channels:
- **ntfy** — `curl -d` to topic URL; `Priority: urgent` when HIGH.
- **Telegram** — `curl` to `api.telegram.org/bot<token>/sendMessage` (same pattern proven in the pool backend).
- **Email** — `sendmail -t` → `mail` → `msmtp`, whichever exists.
- **Nostr** — shells out to `nak` (preferred) or `nostril`+`websocat`; if neither is installed it logs "skipped" (honest — bash can't schnorr-sign alone).

#### Anti-spam rule (important for a 5–15 min timer)

- **Standing findings** (config/key/boot diffs) re-alert **only when the finding-set hash changes** (`last_alert_hash`) — a standing "REBOOT since baseline" doesn't re-fire every tick.
- **Event findings** (new login, clock jump) alert **once each**, deduped by the advancing `seen_logins` set / heartbeat.
- Baseline **primes** `seen_logins` so only logins *after* baseline alert.

### Menu

1 Snapshot baseline (prints off-box hash) · 2 Run check now · 3 Show last report ·
4 Configure alert channels (+ send test) · 5 Scheduled watch (enable/disable, interval) ·
6 Status · 7 Beyond detection (LUKS/wallet-off-VPS pointers) · 0 back.

### Conventions followed

- `set -euo pipefail`; every menu dispatch `||`-guarded; worker calls `|| true`.
- Self-contained sub-script styled on `085_ssh_hardening.sh`; delegated from `08` via `bash "$SCRIPT_DIR/082_…"`.
- Worker re-written on every menu launch (`_aw_install_worker`) so the deployed copy always matches the toolkit.
- `access-watch.log` added to `08`'s `TOOLKIT_LOGROTATE` list (continuous fixed-name log).
- Worker uses `set -uo pipefail` (NOT `-e`) so one failed check can't abort the run.

## Runbook

- **Take the baseline and keep the hash off-box:** menu 1 prints the baseline SHA-256; copy it somewhere the box cannot reach. Re-verify after any incident, then snapshot again to acknowledge legitimate changes.
- **Schedule:** menu 5 enables the `grin-access-watch.timer` (5–15 min). The worker is regenerated on every menu launch, so the deployed copy always matches the toolkit.
- **Syntax-check the worker, not just the script.** The worker lives in a quoted heredoc, so `bash -n scripts/082_provider_access_watch.sh` does NOT check it. Generate it (eval `_aw_install_worker` with `WORKER` / `SCRIPT_DIR` pointed at a scratch dir) and `bash -n` the result. Since the delivery lib is cat'd between two heredocs, extracting between the markers misses the middle.
- **After editing `lib/grin_alert_send.sh`:** re-run the old-vs-new worker diff (nine stubbed channel/tool combinations; 086 implementation §8.17), because a change to the lib changes 082's alerts too.

## Build notes — obstacles & lessons

Built in 6653dfe (2026-07-25); not VPS-tested. Memory source: `project_provider_access_watch`.

### The worker is not covered by `bash -n`
**Symptom (avoided):** a syntax error in the worker ships and the timer fails silently on the box. **Cause:** the worker is written from a quoted heredoc, so the outer script's syntax check never sees it. **Fix:** generate it and check the output (Runbook). **Lesson:** a script that writes a script needs the generated artifact checked, not the generator.

### Sharing the delivery code without making a tamper alert depend on the toolkit
**Driver:** the node event recorder needed the same four channels. **Decision:** `lib/grin_alert_send.sh` is shared but INLINED into 082's worker (`_aw_install_worker` writes heredoc + `cat lib` + heredoc into a temp file and moves it into place), never sourced, so `/opt/grin/access-watch.sh` stays one self-contained file — a tamper alert must not depend on anything else on the box still being intact. The lib's knobs default OFF; 082 sets only the title, `Tags: rotating_light` and its `note` logger, which is why its requests and log lines stayed byte-identical (diffed in nine stubbed combinations). **Lesson:** extract for reuse only when the extraction cannot change what the original sends. Script 03's `lib/grin_alerts.sh` is an older separate copy, not converged.

### A failed worker refresh replaced the good worker
**Symptom:** a missing lib left a half-written worker installed and the error exited the menu. **Fix:** build in a temp file and move it into place; if the lib is missing, keep the installed worker and warn. **Lesson:** generate beside, then `mv`.

### The menu key was a moving target
082 first landed on hub-08 key 7, which is what pushed Backup 089 to key 10 and past the nine digits. The 2026-08-05 re-sort made the key the sub-script's last digit (082 → key 2). **Lesson:** see the key rules in CLAUDE.md; a numbered sub-script's key is its number.

### Nostr cannot be done in bash alone
Bash cannot schnorr-sign, so the Nostr channel shells out to `nak` (preferred) or `nostril` + `websocat` and logs "skipped" when neither exists — an honest skip rather than a pretend send. The config screen says so.

## Open items


- **NOT VPS-tested** — logic + `bash -n` only (worker extracted and checked separately, since it lives in a quoted heredoc).
- Nostr requires `nak`/`nostril` on the box (documented in the config screen).
- auth.log fallback (no journald) dedups by line-hash rather than time window — fine, but on a box with rotated/short auth.log a very old login could re-appear as "new" after log rotation; journald path is unaffected.
- Watches top-level `/etc/systemd/system/*.service|*.timer` only (not `*.wants/` symlink dirs) — extend the `paths` glob in `_collect_files` if deeper coverage is wanted.
