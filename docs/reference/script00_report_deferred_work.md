# Scripts 01 / 03 / 04 — Deferred DRY Migration to Shared Node Libs

> **Covers code as of:** 2026-10-13 · **Last verified:** 2026-10-13, PARTIAL — comment-reorg G8 grepped each item against `scripts/` (not run on a VPS)
> **Product code last changed:** 2026-08-25 — `scripts/lib/grin_node_*.sh` and scripts 01 / 03 / 04 / 08

The 2026-05-31 plan moved node start/session handling into `scripts/lib/grin_node_control.sh`
(`_grin_session_name`, `gnc_launch_node_session`, …) and `grin_node_keepalive.sh`. Scripts 01, 03
and 08 now source the lib and call the launcher; their local `_grin_session_name` copies are gone,
and 01 (`start_grin_tmux`) and 03 (`try_start_from_known_dir`) both start the node through
`gnc_launch_node_session`. What is left:

## Still open

- **04** `_grin_session_name_local` (`04_grin_node_foreign_api.sh` ~L1582) is a byte-identical copy
  of `_grin_session_name` from the lib 04 already sources — delete it and call the canonical one
  (optional; `bash -n` after).
- **03** writes its own `@reboot` line (`add_grin_autostart`, ~L2366) instead of delegating to
  `gnk_autostart_enable`. The two share one crontab tag
  (`# grin-node-toolkit: grin_autostart_<net>`), so whichever front-door wrote the entry last wins.
  Delegating was declined to keep 03's interactive binary detection; revisit if the two ever diverge.
- **Not verified live on a VPS:** autostart entry, watchdog restart, `tmux attach`.
