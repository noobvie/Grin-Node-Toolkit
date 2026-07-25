# Script 082 — Provider / Host-Access Tamper Watch

**Status:** BUILT 2026-07-25 (add-ons branch), NOT VPS-tested.
**Entry:** Admin Centre (08) → Security & Network → `7) Provider Access Watch`
(added as a numeric main-action per convention; Maintenance shifted to 8/9/10).
**Files:** `scripts/082_provider_access_watch.sh` (menu front-end) →
installs worker `/opt/grin/access-watch.sh` + `grin-access-watch.service`/`.timer`.

## Threat model
A rented VPS is untrusted: the provider (or someone with the provider console /
rescue mode / a stolen key) can reboot into rescue, mount the disk offline, or
log in in-band. You **cannot prevent** that from inside the guest, but you **can
detect** its footprints. This script is detection + out-of-band alerting only.

The two measures that actually raise the ceiling are deliberately **out of
scope** (surfaced as pointers in menu option 7, not implemented):
1. LUKS + dropbear-initramfs remote-unlock (defeats disk-at-rest reads).
2. Keep the wallet seed off the public VPS (fits the node/wallet split).

## Signals detected (what maps to what)
| Signal | Source | Severity |
|---|---|---|
| New / removed `authorized_keys` entry | every user's `~/.ssh/authorized_keys`, keyed by `ssh-keygen -l` fingerprint | NEW = HIGH, removed = MED |
| Changed sshd binary / sshd_config(+drop-ins) / sudoers(+.d) / passwd / group / crontab / cron.d / systemd `.service`+`.timer` / hosts.allow/deny / ld.so.preload | SHA-256 manifest diff | MED (HIGH if it's a key/cmdline) |
| Reboot you didn't trigger | `/proc/sys/kernel/random/boot_id` change | MED |
| Kernel changed | `uname -r` | MED |
| Kernel cmdline changed | sha of `/proc/cmdline` (catches `init=`, `single`, rescue) | HIGH |
| New SSH login accepted | journald `_COMM=sshd` "Accepted", fallback auth.log/secure | event (LOW) |
| VM pause / clock jump | heartbeat gap ≫ interval with **no** boot_id change | event (LOW) |

## State layout (`/opt/grin/conf/access-watch/`, dir 700)
- `baseline` — sorted manifest (`authkey …`, `file <path> <sha|MISSING>`, `bootid`, `btime`, `cmdline`, `kernel`), chmod 600.
- `alert.conf` — channel secrets, chmod 600, `%q`-quoted for safe `source`. Keys: `NTFY_URL`, `TG_BOT_TOKEN`+`TG_CHAT_ID`, `MAIL_TO`, `NOSTR_SK`+`NOSTR_RELAY`, `ALERT_ON_LOGIN` (default 1).
- `state/` — `baseline_hash`, `baseline_time`, `last_seen` (epoch heartbeat), `interval_seconds`, `seen_logins` (sha set, primed at baseline, capped 1000→500), `last_report`, `last_status`, `last_check_time`, `last_alert_hash`.

## Alert design (mirrors pool `alert-delivery.js`)
`notify(severity, subject, body)` sends to **every** configured channel; each is
independent (`&& note sent || note FAILED`), one failing never blocks the rest.
- **ntfy** — `curl -d` to topic URL; `Priority: urgent` when HIGH.
- **Telegram** — `curl` to `api.telegram.org/bot<token>/sendMessage` (same pattern proven in the pool backend).
- **Email** — `sendmail -t` → `mail` → `msmtp`, whichever exists.
- **Nostr** — shells out to `nak` (preferred) or `nostril`+`websocat`; if neither is installed it logs "skipped" (honest — bash can't schnorr-sign alone).

### Anti-spam rule (important for a 5–15 min timer)
- **Standing findings** (config/key/boot diffs) re-alert **only when the finding-set hash changes** (`last_alert_hash`) — a standing "REBOOT since baseline" doesn't re-fire every tick.
- **Event findings** (new login, clock jump) alert **once each**, deduped by the advancing `seen_logins` set / heartbeat.
- Baseline **primes** `seen_logins` so only logins *after* baseline alert.

## Tamper-evidence
`baseline` (and its hash) live on the same box an attacker can touch. Mitigation
per CLAUDE.md: option 1 **prints the baseline SHA-256** for the operator to copy
**off-box**; if the on-box baseline is silently rewritten, the saved hash won't
match. Keep the off-box copy; re-verify after any incident, then "Snapshot
baseline" again to acknowledge legitimate changes.

## Menu
1 Snapshot baseline (prints off-box hash) · 2 Run check now · 3 Show last report ·
4 Configure alert channels (+ send test) · 5 Scheduled watch (enable/disable, interval) ·
6 Status · 7 Beyond detection (LUKS/wallet-off-VPS pointers) · 0 back.

## Conventions followed
- `set -euo pipefail`; every menu dispatch `||`-guarded; worker calls `|| true`.
- Self-contained sub-script styled on `085_ssh_hardening.sh`; delegated from `08` via `bash "$SCRIPT_DIR/082_…"`.
- Worker re-written on every menu launch (`_aw_install_worker`) so the deployed copy always matches the toolkit.
- `access-watch.log` added to `08`'s `TOOLKIT_LOGROTATE` list (continuous fixed-name log).
- Worker uses `set -uo pipefail` (NOT `-e`) so one failed check can't abort the run.

## Open / not done
- **NOT VPS-tested** — logic + `bash -n` only (worker extracted and checked separately, since it lives in a quoted heredoc).
- Nostr requires `nak`/`nostril` on the box (documented in the config screen).
- auth.log fallback (no journald) dedups by line-hash rather than time window — fine, but on a box with rotated/short auth.log a very old login could re-appear as "new" after log rotation; journald path is unaffected.
- Watches top-level `/etc/systemd/system/*.service|*.timer` only (not `*.wants/` symlink dirs) — extend the `paths` glob in `_collect_files` if deeper coverage is wanted.
