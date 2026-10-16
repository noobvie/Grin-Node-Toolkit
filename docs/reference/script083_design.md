# Script 083 — Host Optimization & Hardening

> **Covers code as of:** 2026-08-25 (the doc: "built 2026-08-25") · **Last verified:** never systematically verified
> **Product code last changed:** 2026-08-25 — `scripts/083_host_optimization.sh`, `scripts/lib/083_lib_*.sh`

**Status:** built 2026-08-25, **never run on a VPS.** Read-only advisor; no apply paths.
**Menu:** hub 08, key `3`.
**Files:** `scripts/083_host_optimization.sh`, `scripts/lib/083_lib_profile.sh`,
`scripts/lib/083_lib_advice.sh`.

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
