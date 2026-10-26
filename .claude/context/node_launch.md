# Node launch contract + tmux

> Split out of `.claude/CLAUDE.md` (which points here). Read on demand — keep the
> always-loaded CLAUDE.md lean; add new detail HERE, not there.

## tmux Sessions — Always Use Bash
When generating `tmux new-session` commands (cron wrappers, watchdogs, any cron-run code),
always prefix with `SHELL=/bin/bash`:
```bash
SHELL=/bin/bash tmux new-session -d -s "name" -c "$DIR" "command"
```
**Why:** cron sets `SHELL=/bin/sh`; a shebang sets only the interpreter, not the env var
inherited by tmux child sessions. `export SHELL=` is insufficient if the tmux server was
already started — the inline prefix is the only reliable fix.

## Grin Node Launch Contract — Run as `grin`, with `HOME=$GRIN_DIR`, on the gtmux socket
**Every** code path that starts `grin server run` MUST go through
**`gnc_launch_node_session <dir> <binary> <sess>`** in `scripts/lib/grin_node_control.sh`
(or its conf-resolved wrapper `gnc_start_node_tmux <net>`). Never hand-roll a tmux launch.
The launcher enforces:
1. **Run as the `grin` user** — never root. A root-run node writes `root:root` files into the
   node dir; the next `grin`-owned start then gets `EACCES` and won't start.
2. **Set `HOME="$GRIN_DIR"`** (the node dir). grin 5.4.0 creates `$HOME/.grin/<chain>/` even
   when it loads the cwd `grin-server.toml`. The `grin` user's default home `/opt/grin` is
   `root:root`/unwritable → grin panics `Error loading config file: Permission denied`.
3. **`chown -R grin:grin "$GRIN_DIR"` immediately before launch** — reclaims root-owned
   leftovers (idempotent, prevents the EACCES in #1).
4. **One tmux server: grin's socket ("gtmux").** tmux is invoked *inside* `su grin`, so the
   tmux SERVER runs on grin's per-user socket (`/tmp/tmux-<uid>/default`) — view via the
   `gtmux` CLI, invisible to a plain root `tmux ls`. Before starting, the launcher kills the
   session name on BOTH tmux servers and sweeps leftover `grin server run` processes for the
   dir (`gnc_kill_grin_procs`). A root-socket session next to a gtmux one is the classic
   "lock file is held by another grin process" duplicate.

Stop paths must use `gnc_kill_grin_session` / `gnc_kill_all_grin_sessions` (both sockets) and
end with a `gnc_kill_grin_procs` sweep. Session checks use `gnc_has_grin_session` (sets
`GNC_SESSION_SOCKET` = grin|root for the right attach hint). **Every stop path goes through
`gnc_kill_grin_session`** (one that SIGTERMs grin by port first calls `gnc_mark_planned_stop`
before it): that writes the planned-stop marker the node event recorder (086 key 7) needs to tell a
toolkit stop from an outage. The pane command `_gnc_node_run_cmd`, used by the launcher and both
`@reboot` writers, stamps `.grin_last_start` / `.grin_last_exit` in the node dir. Reboot autostart defaults
(`gnk_autostart_enable`, Script 01 Super Auto + Script 03 G): **mainnet 5 s, testnet 1000 s**
(grin v5.5 boot is heavy — a slow VPS cannot start two nodes together).

**Do NOT** debug "node won't start" by running as root in the node dir — it works for root
but leaves `root:root` files that re-break the `grin` user. Reproduce as the service user.

