# Bash conventions — full text

> Split out of `.claude/CLAUDE.md` (which points here). Read on demand — keep the
> always-loaded CLAUDE.md lean; add new detail HERE, not there.

## Common Commands
```bash
# Syntax check a single script
bash -n scripts/059_grin_drop.sh

# Syntax check all scripts at once
for f in scripts/**/*.sh scripts/*.sh; do bash -n "$f" && echo "OK: $f"; done

# Syntax check lib files
for f in scripts/lib/*.sh; do bash -n "$f" && echo "OK: $f"; done

# Search for a function across scripts
grep -n "function_name" scripts/*.sh scripts/lib/*.sh

# Check GRIN/BTC price
curl -s "https://api.nonlogs.io/api/markets/GRIN-BTC" | python3 -m json.tool
```

## Conventions
- Scripts use `set -euo pipefail` at the top
- **Menu loops under `set -e`:** every `case` dispatch MUST be `||`-guarded
  (`fn || true`) — an unguarded non-zero return kills the whole script instead of
  returning to the menu. Same trap: never end a function with `[[ ... ]] && cmd`
  (a false test makes the function return 1); use the `if`-form instead.
- **⚠ The corollary: a function called as `fn || …` or `if fn; then` runs with
  errexit DISABLED for its whole body**, and re-issuing `set -e` inside it does not
  undo that (POSIX ignores it there). Since that `||`-guard is mandatory above, it
  is the NORMAL case for every sourced lib — `set -euo pipefail` in the entry script
  protects almost nothing inside one. So in `lib/`, guard every command that creates,
  copies, moves or deletes with its own `|| { error "..."; return 1; }`, and never
  write a header comment claiming the caller's `set -e` covers you. A bare `cp`/`mv`
  in a lib is a silent failure that ships: 052's build wrote a *valid* SRI for an
  un-overlaid patch, and `mv "$new" "$outdir"` does not fail when `$outdir` still
  exists — it nests inside it while `success` prints. Full rationale → memory
  `project_lib_errexit_suppression`.
- Colors/logging defined once in the main script and inherited via source
- Config written to `/opt/grin/<service>/` on the target server
- Wallet secrets stored in `/opt/grin/<net>/.api_secret` (never hardcode)
- Testnet and mainnet always run independently on separate ports/dirs
- Lib files (scripts/lib/) are sourced, not executed — no shebang needed
- Function names: `snake_case`, prefixed with script prefix (e.g. `drop_`, `node_`)
- Option numbers in menus: numeric for main actions, letters (B/R/D/L) for secondary

- Interactive SESSION logs use `_$(date +%Y%m%d_%H%M%S).log`; continuous fixed-name
  logs (watchdogs, daemons) are rotated via logrotate, not per-run dated.

## Debugging — Confirm Root Cause Before Editing
When a bug is reported, **confirm the root cause with evidence before changing code.** A
plausible-looking suspect is not a confirmed cause.
- Ask the operator to run diagnostics and read the *actual* output first; let evidence point
  to the cause. Don't jump from a guess (a suspicious commit) straight to an edit — state the
  hypothesis, then verify.
- Make sure each diagnostic actually proves what you think — a test that can't observe the
  thing you're checking is not evidence.
- "It worked before" often means a different environment/input, not a code regression — rule
  that out before blaming a change.
- Only once the cause is confirmed, make the **smallest** fix at the true source rather than
  adding compensating logic elsewhere.

