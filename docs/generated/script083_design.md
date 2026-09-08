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

**Two keys changed hands: `3` (was Node Status) and `5` (was SSH).** Per the repo-wide rule a
reassigned key gets **no alias `case` arm** — bash takes the first match, so an alias would
silently open the wrong product instead of erroring. The per-screen banner is the mis-key
safety net. 085 keeps its number; only its route into the menu moved.

## 5. Architecture

```
083_host_optimization.sh     menu, rendering, export, dispatch to 085
  lib/083_lib_profile.sh     facts   — every fn echoes ONE value or "unknown"
  lib/083_lib_advice.sh      checks  — facts → scored findings
  lib/grin_node_secrets.sh   grin_live_node_dir() for per-node peer sizing
```

Findings are six parallel arrays (`ADV_SEV/AREA/TITLE/OBS/REC/FIX`) appended by `adv_add`.
Severities: `CRIT` (live risk) · `WARN` (bites under load or on reboot) · `INFO` · `OK`
(checked and healthy — printed so a clean box reads as *verified*, not as a check that
silently didn't run) · `NA` (not applicable on this host).

### Four traps the libs are built around

**`unknown` must never be a number.** `(( unknown > 4 ))` is a bash *syntax error*, not a
false. Every numeric comparison is gated by `adv_is_num` first.

**An empty string is not the same as `unknown`, and that gap invents findings.** The
`|| echo unknown` fallbacks fire only on a **non-zero exit** — but `awk`/`sed`/`grep -o`
routinely succeed while printing *nothing* (a `df` mount point absent from `/proc/mounts`, a
bind mount, a sysfs file with no bracketed selection). The empty result then slips past every
`[[ "$v" != "$HP_UNKNOWN" ]]` guard and renders as a real measurement. This was caught in
testing: the advisor reported an atime finding about a filesystem it had never read. Every
value-returning probe is now piped through **`_hp_out`**, which normalises blank to `unknown`.

**`grep -c` prints "0" *and* exits 1, so `|| echo 0` emits two lines.** The idiomatic
`… | grep -c pattern || echo 0` produces `"0\n0"` on the zero-match case. That value then
fails `adv_is_num` and the finding it feeds is dropped silently. It bit
`hp_pending_security_updates`, where the zero case is a *fully patched box* — so the one
host that deserved the "no security updates pending" OK line was the only host that never
got it. A check that disappears exactly when it passes is worse than no check. Both
`grep -c` sites now swallow the status with `|| true` and normalise the value instead.

**Grade a listening socket by "is it loopback", never by "is it the wildcard".** The
node-API exposure check originally tested `bind == 0.0.0.0:$port`. A node bound to one
specific *public* IP — a normal way to publish a node deliberately — matches no wildcard
pattern, so it fell into the `else` branch and was handed the OK line *"not directly
reachable from the internet"*: the exact opposite of the truth, on the most safety-critical
check in the tool. Loopback is a short closed list and public is everything else, so the
test asserts the safe case and treats the remainder as exposed (`_adv_is_loopback_bind`).
Two related points fell out of the same fix: a port normally carries **two** listeners
(v4 and v6), so every row is read rather than `head -1` — otherwise the safe one masks the
exposed one — and `ss -tlnH` was replaced by the repo's `ss -tln | tail -n +2`, because
`-H` needs iproute2 ≥ 4.5 and on an older box `ss` exits non-zero printing nothing, which
in hub 08 would read as "no listener" and reinstate the very false-OFFLINE bug being fixed.

**Errexit:** both libs are sourced into a script whose dispatch is `fn || true`, which
disables errexit for the entire callee body. Nothing in either lib relies on `set -e`.

## 6. What is checked

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

### The highest-value security check

Ports 3413/13413 carry no auth beyond a shared secret and were never meant to face the
internet. 083 reads the **bind address** from `ss` and grades it against firewall state:

- **not** loopback (`0.0.0.0`, `[::]`, or any specific public IP) **and** no active
  firewall → `CRIT`, exposed right now
- **not** loopback **with** ufw up → `WARN`, the firewall is the only thing in the way
- every listener on the port is loopback → `OK`

Script 04 remains the supported way to publish chain data — it serves the **foreign** API
only and 403s the owner API.

### On the sizing numbers

The peer-limit tiers (25 / 50 / 100 by RAM) are **toolkit heuristics, labelled as such in the
finding text**, not measured limits. Script 01's `999` is correct for a community seed node on
a well-resourced box; the check exists to catch the mismatch on a small one, not to argue with
the default. The finding says so explicitly and tells the operator to raise it once they can
watch memory under load.

## 7. Testing done

Local only — the scripts have never run on a VPS.

- `bash -n` on all three files.
- Lib harness exercising every probe on a host where `/proc/mounts`, `systemctl`, `ufw` and
  `apt` are absent or partial — i.e. the "unknown" paths, which are where the arithmetic
  traps live. `adv_run_all` completes without aborting.
- Render harness that `eval`s the **shipped** render functions (not a copy) against:
  populated registry, empty registry, an area with no findings, and long-prose wrapping.
- Table-driven check of `_adv_is_loopback_bind` over all seven address forms `ss` emits.
- The empty-vs-unknown defect in §5 was found this way and fixed.

**Review pass, 2026-08-25** (after the first build, before any VPS run). Fixed: the
loopback mis-grading and the `grep -c` double-output above; `ulimit -Sn` returning
`unlimited` made the whole fd check vanish; `PermitRootLogin forced-commands-only` and any
unrecognised value produced no finding at all; three separate `sshd -T` invocations that
could disagree with each other collapsed to one; `xargs` used as a whitespace trimmer
(it also does quote processing and *errors* on an unmatched quote) replaced by `_hp_trim`.
UX: menu rows covering two areas profiled the host twice and demanded two Enter presses —
`show_single_area` is now variadic; the ~100-line full report is paged through the
toolkit's house `less -FRX`, since the CRIT findings sort to the top and were the first
thing to scroll away unread; `_wrap` reads `tput cols` because `COLUMNS` is unset in a
non-interactive child; the `chmod +x` before dispatching to 085 is gone, as a tool that
advertises "changes nothing" should not be chmod'ing files.

## 8. Screen-exit and prompt-cancel conventions

Two operator-reported gaps, fixed 2026-08-25 in `scripts/lib/ui_shared_helpers.sh`
(unnumbered because it is cross-script, following the `nginx_shared_helpers.sh` precedent).

**Every long read-only screen ends with an explicit `[END]` marker** (`ui_end`), carrying the
finding counts and *"nothing was changed"*. A report that simply stops leaves the operator
unsure whether it was truncated or is still running. The exit prompt is now stated rather
than implied, and it names the right key: `_page` measures the content against `tput lines`
instead of leaving that to `less -F`, sets `UI_PAGED`, and `_end_pause` mentions `q` **only**
when the screen actually went through the pager.

**Value prompts can be cancelled with `q` instead of Ctrl+C.** `ui_ask` / `ui_ask_num`
return non-zero when the operator backs out; the caller must return without acting. This is
a safety fix, not a convenience one — Ctrl+C kills the whole menu script rather than the
prompt, and several hub-08 prompts treated a bare Enter as *"take the default and proceed"*,
so the instinctive way to back out **confirmed** the action. The worst was the self-update
custom-branch prompt: an empty Enter answered *"Defaulting to 'main'"* and armed an update
from a branch the operator never chose. Ten prompts in hub 08 were converted; `[y/N]`
confirmations were left alone, since Enter already means "no" there.

Cancel is `q`, not `0` or Enter, because `0` is already both a legal value ("0 archives")
and "back" in sub-menus, and Enter already means "accept the default" — one key cannot mean
both *proceed with the default* and *do nothing*.

Two traps in the helper itself, both caught by testing rather than review:

- `printf -v "$name"` writes to whatever `$name` says, and bash's dynamic scoping puts the
  callee's locals in scope — so a caller asking `ui_ask` to fill `_uia_ans` silently
  overwrites `ui_ask`'s own working variable and gets rc 0 with an empty value. Long
  unlikely names make that improbable, not impossible; `_ui_name_ok` asserts it.
- That guard must take the reserved prefix as a **parameter**. A blanket "reject anything
  starting `_ui`" also refuses the lib's own internal call (`ui_ask_num` legitimately asks
  `ui_ask` to fill `_uin_val`) — which made *every* `ui_ask_num` in the toolkit return
  "cancelled" while looking perfectly correct on the page.

## 9. Open / next

1. **Run it on a real VPS.** Nothing here is validated against a live node.
2. Per-item apply paths with recorded before-values, once (1) confirms the advice.
3. Optional IO benchmark (off by default, disruptive on a live node) — deliberately omitted
   for now rather than shipped as a default.
4. Feed the profiler back into Script 01 so its swap and `peer_max_inbound_count` are sized
   rather than hardcoded. Deferred by the user: Script 01 works and is not to be touched yet.
