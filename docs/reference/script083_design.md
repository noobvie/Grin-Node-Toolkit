# Script 083 — Host Optimization & Hardening

> **Covers code as of:** 2026-11-01 · **Last verified:** never systematically verified
> **Product code last changed:** 2026-11-01 (uncommitted) — `scripts/083_host_optimization.sh`, `scripts/lib/083_lib_*.sh`, `scripts/lib/08_lib_host_updates.sh`, `scripts/lib/081_lib_host_updates.sh`

**Status:** built, **never run on a VPS.** Read-only advisor plus one apply path, Automatic
Security Updates (key `9`, §10).
**Menu:** hub 08, key `3`.
**Files:** `scripts/083_host_optimization.sh`, `scripts/lib/083_lib_profile.sh`,
`scripts/lib/083_lib_advice.sh`, `scripts/lib/08_lib_host_updates.sh`.

---

## 1. Why this exists

A fresh Ubuntu 24 VPS is not configured for a Grin node, and the toolkit had no place
that said so. What existed was scattered and unsized:

- Script 01 writes swap + `vm.swappiness=10` + `vfs_cache_pressure=50` at build time, with
  **hardcoded** values — right for a mid-size box, wrong at both ends of the range. It also
  sets `peer_max_inbound_count = 999` unconditionally.
- Hub 08 had swap add/remove, disk cleanup, SSH hardening (085), nginx security (084).
- **Nothing** covered: firewall setup (085 only *reads* `ufw status`), fail2ban,
  unattended-upgrades, time sync, `LimitNOFILE`, THP, IO scheduler, atime, journald caps,
  CPU steal, or whether the node API is exposed to the internet.

083 profiles the actual box and reports what *this* host needs, sized from measurements.

## 2. The central design decision — advisory only

**083 changes nothing.** Every finding carries a `fix:` line the operator runs themselves.

This is deliberate, not an unfinished feature. The target is a remote VPS:

- A wrong sysctl is recoverable.
- `ufw enable` issued before an SSH allow-rule is a box reachable only from the provider's
  console. That failure is silent, immediate, and total.

So the order is **suggest → verify on real nodes → automate**. Once the recommendations are
shown to hold, per-item apply paths can be added behind explicit consent, each recording the
value it replaced. Adding them before the advice has ever been checked against a running node
would be automating unverified guesses.

The report stays advisory. The first apply path is Automatic Security Updates (§10), chosen
because it cannot cause the failure above: it touches no firewall, SSH or network setting,
never reboots, never touches the grin node or pool, and its Disable removes only what it wrote.

A corollary that is easy to get wrong: **zero findings is not a pass.** `_render_summary`
special-cases an empty registry as *"the profile did not run correctly"* rather than "good
shape" — a hardening tool that reports health when its probes failed is worse than no tool.

## 3. SSH: reported here, changed only in 085

083 shows SSH posture (port, `PermitRootLogin`, `PasswordAuthentication`) and offers a
drill-down that dispatches to `085_ssh_hardening.sh`. It never edits SSH itself.

085 owns the staged rollout, `sshd -t` validation, reload-not-restart, and the dead-man
timer. A second path to the same change would be a worse path. This is a **navigation
merge, not a code merge** — 085's file and script number are unchanged.

## 4. Menu numbering — why two keys changed hands

Hub 08 keys each numbered sub-script to its last digit and fills gaps with inline features.
Before 083 the digits 1–9 were fully occupied, so a 10th row was impossible (the header
already records this wall being hit once, when Service & Port Dashboard and Chain Sync
Status were merged).

Folding SSH into 083 freed key `5` and made the mapping work again:

| Key | Row | Script |
|-----|-----|--------|
| 1 | Remote Node Manager | 081 |
| 2 | Provider Access Watch | 082 |
| **3** | **Host Optimization & Hardening** | **083** |
| 4 | Nginx Extended Features | 084 |
| **5** | **Node Status & Sync** | inline (moved from 3) |
| 6 | Top 20 Bandwidth Consumers | inline |
| 7 | Disk Cleanup | inline |
| 8 | Self-Update | inline |
| 9 | Backup & Restore | 089 |

Four numbered scripts on their own digits, four inline features in the gaps — the rule holds.

> **Later change (2026-09-25):** key `6` now opens **086 Diagnostics & Support Bundle**; Top 20
> Bandwidth Consumers moved into 084 as its option `5`. The table above is the menu as 083 left it.
> See [script086_design.md](script086_design.md).

**Two keys changed hands: `3` (was Node Status) and `5` (was SSH).** Per the repo-wide rule a
reassigned key gets **no alias `case` arm** — bash takes the first match, so an alias would
silently open the wrong product instead of erroring. The per-screen banner is the mis-key
safety net. 085 keeps its number; only its route into the menu moved.

## 5–9. As built → [`script083_implementation.md`](script083_implementation.md)

The architecture, the list of checks, the testing notes, the screen-exit and prompt-cancel conventions and the open items moved to the implementation doc; the traps and review findings are its Build notes.

| Was | Now (implementation doc) |
|---|---|
| §5 Architecture, incl. the four traps | What shipped › Architecture · Build notes › Probes that lie |
| §6 What is checked | What shipped › What is checked |
| §7 Testing done, review pass | Runbook › Local testing · Build notes |
| §8 Screen-exit and prompt-cancel conventions | Build notes › Screens and prompts |
| §9 Open / next | Open items |

## 10. Automatic Security Updates (key 9)

**Status:** built, not VPS-tested. Enable/disable verified only against a scratch tree (see
the implementation doc's Runbook).

A node runs unattended for months, so the OS patches have to apply without the operator —
but an unattended run must never take the node down. The contract:

- **Security channel only.** Ubuntu's `-security` pocket (plus the ESM security pockets),
  Debian's `security.debian.org`, dnf's `upgrade_type = security`. Not `-updates`, not Debian
  point releases.
- **Never reboots; library updates never restart services.** `Automatic-Reboot "false"` /
  `reboot = never`, and needrestart is list-only, so a patched libssl leaves every service on
  the old library until the operator restarts it; status says which ones and whether a reboot
  is pending. What it cannot stop: a patched *daemon package* (nginx, tor, php-fpm, openssh)
  restarts its own service from its maintainer script (Debian `dh_installsystemd`
  restart-after-upgrade; EL `%systemd_postun_with_restart`). That is a seconds-long blip on
  the patched service, and no blacklist is added to avoid it — holding back a patched nginx
  defeats the point. The grin node and the pool are not packages, so no update touches them.
- **The stock policy file is never edited.** `50unattended-upgrades` and the stock
  `automatic.conf` defaults stay as shipped. Two package-owned files are rewritten, each after
  a one-time copy into `/var/lib/grin-toolkit/host-updates/`: `20auto-upgrades` (the
  package's on/off switch, registered with ucf by the unattended-upgrades postinst — the same
  file `dpkg-reconfigure unattended-upgrades` writes) and, on dnf 4, `/etc/dnf/automatic.conf`.
  Every toolkit-written file carries a marker line; disable changes a file only while that
  marker is still there, so an operator's later edit is left alone with a warning.
- **Fail closed.** After writing, enable reads the *effective* config back; if it is not
  security-only, not scheduled (both `APT::Periodic` values and both apt-daily timers), or
  allows an automatic reboot, enable fails without `__OK__` and leaves its files for
  inspection. run-now repeats the policy and reboot check and refuses on a mismatch.
- **"Disable" means off.** The schedule is turned off even if the host had it on before
  enable; the pre-enable copy is kept for anyone who wants it back. No package is purged.
  Disable ends by reading the state back and says so if updates are still on through
  configuration the toolkit did not write.
- **State outside `/opt/grin`.** The full cleanup (08del) deletes `/opt/grin` but leaves this
  policy in place — it protects the host whether or not Grin stays — so the state file and
  backups live in `/var/lib/grin-toolkit/host-updates/` beside it. 08del's closing screen says
  the policy was kept and where to turn it off.
- **Third-party repos are reported, never silently added.** NodeSource is an explicit opt-in
  (default No, apt only) because it ships every Node.js 24.x release, features included — an
  unattended run would move the runtime under the pool and web apps. A third-party PHP repo
  (ondrej / sury, remi) is surfaced in status as not covered. No toolkit product adds one
  today: 051x installs the distro `php-fpm`, and on EL the toolkit only adds EPEL (for tor) —
  EPEL ships its own security advisories, so dnf's security filter covers it.

### Why snippets, not functions

The same work must run on this box (083) and on remote boxes from 081 Mass Deployment over
SSH, where no toolkit lib exists. So each action (`status`, `enable`, `disable`, `run-now`) is
one self-contained bash script built by `hu_script`, plain-text `key=value` output, `__OK__`
as its last line. 083's menu is a thin renderer over the same text 081 Mass Deployment (key
`5`) parses — there is one implementation, never a local and a remote copy. run-now is never
streamed, locally or remotely: 083 itself is used over SSH, and a dropped session would HUP the
job and close the output pipe under dpkg/rpm. Both callers start it through one shared
launcher (systemd-run or setsid, logging on the host) and only poll it (as built → the
implementation doc, "Detached patch runs").

### apt: lists append, so the policy must `#clear` first

apt config lists **append** across `apt.conf.d` files (checked with `apt-config dump`): a
higher-numbered file that lists only security origins still inherits every origin in the
stock `50unattended-upgrades`, which on Ubuntu includes the release pocket and on Debian the
whole point-release archive. Editing the stock file would fight dpkg's conffile handling.
The toolkit drop-in `52grin-unattended-upgrades` therefore opens with apt.conf's `#clear`
directive for `Allowed-Origins` and `Origins-Pattern`, then lists its own. Files are read in
lexical order, so a file numbered above 52 can still widen the list or flip
`Automatic-Reboot` — enable fails, run-now refuses, and status flags it.

The read-back classifies each effective entry by **exact match** against the known security
patterns (ours plus the stock security entries), never by "contains `security`": a pattern
such as `origin=*` must read as *not* security-only.

Origins, each read off the live `Release` file:

| Source | Release fields | Pattern |
|---|---|---|
| Ubuntu security | Origin `Ubuntu`, Suite `<codename>-security` | `origin=Ubuntu,archive=${distro_codename}-security` |
| Ubuntu ESM | `UbuntuESM` / `<codename>-infra-security`; `UbuntuESMApps` / `<codename>-apps-security` | same shape |
| Debian 12/13 | Origin `Debian`, Label `Debian-Security`, Codename `<codename>-security` | `origin=Debian,codename=${distro_codename}-security,label=Debian-Security` |
| NodeSource (opt-in) | Origin `. nodistro`, Label `. nodistro`, Codename `nodistro` (aptly-generated) | `site=deb.nodesource.com,codename=nodistro` |

NodeSource matches on `site=` rather than its odd `. nodistro` Origin string; `site` is a
documented unattended-upgrade key.

### dnf: dnf 4 on EL10, dnf 5 handled too

EL10 ships dnf 4: package `dnf-automatic`, timer `dnf-automatic.timer`. A dnf 5 host uses
`dnf5-plugin-automatic` and `dnf5-automatic.timer`. Both read `/etc/dnf/automatic.conf`
(dnf 5 layers it over `/usr/share/dnf5/dnf5-plugins/automatic.conf`; there is no
`/etc/dnf/dnf5-plugins/` path). On dnf 4 that file is the package's own full config, so it
is backed up before being replaced and restored byte-for-byte by disable (whenever the backup
exists, even if the state file was lost). Disable also turns off dnf 4's
`dnf-automatic-install.timer`, which always applies updates whatever the config says.
NodeSource's rpm repo publishes no advisories, so a security-only dnf never updates nodejs;
status says so, and the enable screen does not ask the NodeSource question on dnf.

Status probes on dnf run cache-only (`-C`) under `timeout`, so a status read never waits on
the dnf lock or a metadata refresh (a missing cache reads as `unknown`).
`needs-restarting` is a plugin, and a missing plugin exits 1 — the same code that means
"reboot required" — so the plugin is detected first and the answer is read from its text.

### needrestart

Ubuntu 24.04's needrestart restarts services by itself after a non-interactive upgrade. A
drop-in `/etc/needrestart/conf.d/50-grin.conf` sets `$nrconf{restart} = 'l'` (list only),
and the patch run also exports `NEEDRESTART_MODE=l` so the rule holds even without the
drop-in. needrestart is configured where present, never installed. This covers library
updates only — see the daemon-package caveat above.

### Pending count and the patch run

The pending count is `apt-get -s dist-upgrade`, not `upgrade`: `upgrade` holds back any
update that needs a new package — a kernel ABI bump, or a security-pocket library whose
dependency changed — which is exactly the fix that matters most (on the WSL test box,
`upgrade` showed 0 security updates and `dist-upgrade` showed 1). 083's report uses the same
probe. The patch run ignores SIGINT and SIGHUP around the package manager and says so on
screen: Ctrl-C mid-dpkg leaves half-configured packages.
