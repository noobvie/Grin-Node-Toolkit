# Scripts 01 / 03 — Deferred DRY Migration to Shared Node Libs

**Status:** TODO (not yet done — capture so it isn't forgotten)
**Created:** 2026-05-31
**Context:** Track B (solo-mining supervision) introduced three shared libs:

- `scripts/lib/grin_node_control.sh` — node primitives (`_grin_session_name`,
  `gnc_resolve_node_dir` [CONF-ONLY], `gnc_node_binary`, `gnc_get_pid_on_port`,
  `gnc_wait_for_port`, `gnc_start_node_tmux` [`SHELL=/bin/bash`],
  `gnc_owner_get_status`, `gnc_status_field`).
- `scripts/lib/grin_node_keepalive.sh` — `@reboot` autostart + node-sync watchdog.
- `scripts/lib/grin_wallet_install.sh`, `scripts/lib/07_solo_wallet.sh` — wallet side.

**Script 07 already migrated** (sources the libs; its local `_grin_session_name`
was removed). Scripts **01** and **03** (and **08**, **04**) still carry their own
copies. This file lists exactly what to change when adapting them — do it
incrementally, `bash -n` after each edit.

---

## 1. De-duplicate `_grin_session_name()` (the canonical copy now lives in the lib)

The lib version uses **underscores** (`grin_pruned_mainnet`) and matches
`_find_grin_session_for_pid`'s `grep '^grin_'`.

| File | Local def | Action |
|------|-----------|--------|
| `scripts/01_build_new_grin_node.sh` | line ~2284 (uses at ~353, ~2323, ~2389) | source `grin_node_control.sh`, delete local def |
| `scripts/03_grin_share_chain_data.sh` | line ~132 (uses at ~717, ~1282) | source `grin_node_control.sh`, delete local def |
| `scripts/08_grin_node_admin.sh` | line ~54 | source lib, delete local def |
| `scripts/04_grin_node_foreign_api.sh` | line ~1391 `_grin_session_name_local()` (variant) | optional — fold into lib if behaviour identical |

**How:** add near each script's other `source` lines:
```bash
source "$SCRIPT_DIR/lib/grin_node_control.sh"
```
The lib is source-guarded and defines `info/warn/error/success` fallbacks only if
absent, so it won't clobber a caller's richer logging. Source it **before** any
local function that referenced the old name.

---

## 2. Reconcile Script 03's `@reboot` autostart line with the lib

Script 03's autostart (`add_grin_autostart`, line ~1794) builds:
```bash
@reboot sleep $delay && cd $GRIN_DIR && env SHELL=/bin/bash tmux new-session \
        -d -s $TMUX_SESSION $GRIN_BINARY $cron_marker
```
Two divergences from the new code:

1. **Session name is DASHED** — `TMUX_SESSION="grin-${NODE_TYPE}-${NETWORK_TYPE}"`
   (line ~1766) → e.g. `grin-pruned-mainnet`, whereas the lib / everything else
   uses **underscores** (`grin_pruned_mainnet`). Pick the underscore convention.
2. **Bare binary, no `server run`** — the autostart line runs `$GRIN_BINARY`
   directly, while 03's own `try_start_from_known_dir` (line ~1288) uses
   `./grin server run`. Standardise on `server run`.

**Interop note:** `grin_node_keepalive.sh`'s `gnk_autostart_enable` writes the
**same crontab comment tag** Script 03 uses
(`# grin-node-toolkit: grin_autostart_<net>`), so 03 and 07 are two front-doors to
ONE `@reboot` entry (grep-by-tag → replace, never append). **Until 03 is migrated,
whichever script wrote the entry last wins**, and the `tmux attach` target differs
(dashed vs underscore session name). Migrating 03 to call `gnk_autostart_enable`
removes the divergence.

**Action:** replace `add_grin_autostart` / `remove_grin_autostart` bodies with calls
to `gnk_autostart_enable <net> [delay]` / `gnk_autostart_disable <net|all>`.

---

## 3. Migrate Script 03's `try_start_from_known_dir` → `gnc_start_node_tmux`

`try_start_from_known_dir` (line ~1233) has two issues the shared starter fixes:

1. **Missing `SHELL=/bin/bash`** — line ~1287 uses a bare `tmux new-session`. From
   cron that inherits `SHELL=/bin/sh` and can break the tmux child. `gnc_start_node_tmux`
   always prefixes `SHELL=/bin/bash`. *(This is the latent cron bug the flowchart
   calls out at "RESTART ACTION".)*
2. **Default-dir fallback** — `try_start_from_known_dir` falls back to
   `/opt/grin/node/<default>` when the instances conf has no entry (lines ~1256-1272).
   The shared resolver `gnc_resolve_node_dir` is **CONF-ONLY by design** — a node
   absent from `grin_instances_location.conf` is never guessed at / restarted.

**Decision needed when migrating:** Script 03's interactive flow may still *want* the
default-dir fallback for first-run convenience. If so, keep that fallback **in 03's
interactive path only**, and use `gnc_start_node_tmux` (conf-only) for the
cron/automated path. Do **not** add a default-dir fallback to the shared lib.

---

## 4. Optional: route Script 01's node start through the lib

Script 01 (`start_grin_tmux` / the start logic around lines ~353, ~432-440, ~684)
can call `gnc_start_node_tmux` once 01 sources the control lib, removing its own
session-name + tmux duplication. Lower priority than 03 (01 is the builder, run once
per install; 03 + the watchdog are the hot supervision paths).

---

## Acceptance checklist (per script)

- [x] `01` sources `grin_node_control.sh`; local `_grin_session_name` removed. (2026-06-01)
- [x] `03` sources `grin_node_control.sh`; local `_grin_session_name` removed. (2026-06-01)
- [x] `08` sources the lib; local `_grin_session_name` removed. (2026-06-01)
- [x] `03` autostart uses underscore session name + `server run`. (2026-06-01 — fixed
      in place via `_grin_session_name "$GRIN_DIR"`; did NOT delegate to
      `gnk_autostart_enable` to preserve 03's interactive binary-detection flow.)
- [~] `03` cron/automated start uses `gnc_start_node_tmux` (has `SHELL=/bin/bash`).
      PARTIAL: `try_start_from_known_dir` now has the `SHELL=/bin/bash` prefix
      (the cron bug is fixed), but it was NOT migrated to `gnc_start_node_tmux`
      — 03 keeps its own default-dir fallback for the interactive first-run path.
      Full delegation (conf-only cron path + fallback kept for interactive) remains
      OPEN if/when desired.
- [x] Conf-only resolution preserved in shared paths (no default-dir fallback in lib).
- [x] `bash -n` clean on every touched file. (`/check` + `/review` still recommended.)
- [ ] Verified live on the VPS (autostart entry, watchdog restart, `tmux attach`).

### Still open
- **04** `_grin_session_name_local` (line ~1391) not folded into the lib (optional, §1).
- Full **03** `try_start_from_known_dir` → `gnc_start_node_tmux` migration (above).
- **01** node-start (`start_grin_tmux`) still has its own tmux/session code (§4, low priority).
