# Script 083 — Host Optimization & Hardening: implementation

> **Covers code as of:** 2026-08-25 (the doc: "built 2026-08-25") · **Last verified:** never systematically verified
> **Product code last changed:** 2026-08-25 — `scripts/083_host_optimization.sh`, `scripts/lib/083_lib_*.sh`
> **Scope:** the architecture, checks and conventions as built, plus the Build notes. The rationale (why advisory-only, SSH routing, menu keys) is `script083_design.md`.

**Status:** built 2026-08-25, **never run on a VPS.** Read-only advisor; no apply paths.
**Menu:** hub 08, key `3`.
**Files:** `scripts/083_host_optimization.sh`, `scripts/lib/083_lib_profile.sh`,
`scripts/lib/083_lib_advice.sh`.

## What shipped

### Architecture

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

## Runbook

Open the tool from hub 08, key `3`. It profiles the host, prints findings by area (CRIT first), pages the full report, and changes nothing. Every finding carries a `fix:` line to run yourself; SSH changes go through 085.

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
Both libs are sourced into a script whose dispatch is `fn || true`, which disables errexit for the entire callee body; nothing in either lib relies on `set -e`.

## Open items

1. **Run it on a real VPS.** Nothing here is validated against a live node.
2. Per-item apply paths with recorded before-values, once (1) confirms the advice. Do not add apply paths before then: `ufw enable` before an SSH allow-rule leaves a box reachable only from the provider's console.
3. Optional IO benchmark (off by default, disruptive on a live node) — deliberately omitted rather than shipped as a default.
4. Feed the profiler back into Script 01 so its swap and `peer_max_inbound_count` are sized rather than hardcoded. Deferred by the user: Script 01 works and is not to be touched yet.
