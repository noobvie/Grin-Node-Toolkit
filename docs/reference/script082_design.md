# Script 082 — Provider / Host-Access Tamper Watch

> **Covers code as of:** 2026-07-25 (the doc: "BUILT 2026-07-25"); the *Alert design* section
> 2026-10-03 · **Last verified:** never systematically verified
> **Product code last changed:** 2026-10-03 — `scripts/082_provider_access_watch.sh` (alert
> delivery moved into `scripts/lib/grin_alert_send.sh`, inlined into the worker; no behaviour change)
> The menu-key note was updated 2026-08-06; the rest is the 2026-07-25 build.

**Status:** BUILT 2026-07-25 (add-ons branch), NOT VPS-tested.
**Entry:** Admin Centre (08) → Monitoring → `2) Provider Access Watch`
(key = sub-script number since the 2026-08-05 re-sort: 082 → key 2. It first
landed on key 7, which is what put Backup 089 on key 10.)
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

## Tamper-evidence
`baseline` (and its hash) live on the same box an attacker can touch. Mitigation
per CLAUDE.md: option 1 **prints the baseline SHA-256** for the operator to copy
**off-box**; if the on-box baseline is silently rewritten, the saved hash won't
match. Keep the off-box copy; re-verify after any incident, then "Snapshot
baseline" again to acknowledge legitimate changes.

## Signals, state, alerts, menu → [`script082_implementation.md`](script082_implementation.md)

The signal table, the state layout, the alert channels and anti-spam rule, the menu, the conventions and the open items are the as-built record and live in the implementation doc, with the Build notes.
